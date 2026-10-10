import type { Client } from '../db';

/**
 * Fraud rules (Milestone 5, part A).
 *
 * Every rule is a query that runs INSIDE the transfer transaction, after the
 * account rows are locked and before anything is committed. Because the sender's
 * wallet row is locked, two concurrent transfers from the same wallet are
 * evaluated one after the other - a burst can't slip under a velocity limit by
 * being checked "at the same time". Thresholds come from the risk_rules table.
 *
 * Time windows use now(), NOT clock_timestamp(): now() is STABLE, so Postgres can turn
 * "created_at >= now() - interval" into an index range condition. clock_timestamp() is
 * VOLATILE and silently forces a scan of the sender's whole history (measured: see docs/explain.md).
 *
 * Index used by each rule:
 *   LARGE_AMOUNT        none needed - compares the request's own amount
 *   VELOCITY            transfers_source_created_idx (source_account_id, created_at DESC)
 *   DAILY_VOLUME        transfers_source_created_idx (same index, wider window)
 *   NEW_RECIPIENT_HIGH  transfers_source_dest_idx    (source_account_id, destination_account_id)
 */
export type Fired = {
  code: string;
  action: 'HOLD' | 'FLAG';
  detail: Record<string, unknown>;
};

export type RiskContext = {
  type: 'PEER_TRANSFER' | 'WITHDRAWAL';
  sourceId: number;
  destId: number;
  amount: number;
};

export async function evaluateRules(client: Client, t: RiskContext): Promise<Fired[]> {
  const { rows: rules } = await client.query<{
    code: string;
    action: 'HOLD' | 'FLAG';
    params: Record<string, number>;
  }>('SELECT code, action, params FROM risk_rules WHERE enabled ORDER BY id');

  const fired: Fired[] = [];
  for (const rule of rules) {
    const p = rule.params;
    switch (rule.code) {
      case 'LARGE_AMOUNT': {
        if (t.amount >= p.threshold_paise) {
          fired.push({
            code: rule.code,
            action: rule.action,
            detail: { amount: t.amount, threshold_paise: p.threshold_paise },
          });
        }
        break;
      }
      case 'VELOCITY': {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM transfers
            WHERE source_account_id = $1
              AND type IN ('PEER_TRANSFER', 'WITHDRAWAL')
              AND status IN ('COMPLETED', 'HELD', 'REVERSED')
              AND created_at >= now() - make_interval(mins => $2::int)`,
          [t.sourceId, p.window_minutes],
        );
        // this transfer would be number n+1 inside the window
        if (rows[0].n >= p.max_transfers) {
          fired.push({
            code: rule.code,
            action: rule.action,
            detail: { prior_in_window: rows[0].n, max_transfers: p.max_transfers, window_minutes: p.window_minutes },
          });
        }
        break;
      }
      case 'DAILY_VOLUME': {
        const { rows } = await client.query<{ total: number }>(
          `SELECT COALESCE(SUM(amount), 0) AS total
             FROM transfers
            WHERE source_account_id = $1
              AND type IN ('PEER_TRANSFER', 'WITHDRAWAL')
              AND status IN ('COMPLETED', 'HELD', 'REVERSED')
              AND created_at >= now() - make_interval(hours => $2::int)`,
          [t.sourceId, p.window_hours],
        );
        if (rows[0].total + t.amount > p.limit_paise) {
          fired.push({
            code: rule.code,
            action: rule.action,
            detail: { prior_total: rows[0].total, this_amount: t.amount, limit_paise: p.limit_paise },
          });
        }
        break;
      }
      case 'NEW_RECIPIENT_HIGH': {
        if (t.type !== 'PEER_TRANSFER' || t.amount < p.threshold_paise) break;
        const { rows } = await client.query<{ seen: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM transfers
              WHERE source_account_id = $1 AND destination_account_id = $2
                AND status IN ('COMPLETED', 'REVERSED')) AS seen`,
          [t.sourceId, t.destId],
        );
        if (!rows[0].seen) {
          fired.push({
            code: rule.code,
            action: rule.action,
            detail: { amount: t.amount, threshold_paise: p.threshold_paise },
          });
        }
        break;
      }
      default:
        // unknown rule code in the table: ignore rather than block payments
        break;
    }
  }
  return fired;
}

export async function recordFlags(
  client: Client,
  transferId: number,
  fired: Fired[],
  held: boolean,
): Promise<void> {
  for (const f of fired) {
    await client.query(
      `INSERT INTO risk_flags (transfer_id, rule_code, action_taken, detail)
       VALUES ($1, $2, $3, $4)`,
      [transferId, f.code, held && f.action === 'HOLD' ? 'HELD' : 'FLAGGED', JSON.stringify(f.detail)],
    );
  }
}
