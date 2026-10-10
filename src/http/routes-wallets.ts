import { errors } from '../errors';
import { authenticate, type Ctx } from './context';
import { pathId, queryInt } from './validate';

/** A wallet is visible only to its owner; anyone else gets 404 (we don't confirm it exists). */
async function ownedWallet(ctx: Ctx, walletId: number, userId: number) {
  const { rows } = await ctx.pool.query<{ id: number; balance: number; currency: string }>(
    `SELECT id, balance, currency FROM accounts WHERE id = $1 AND kind = 'USER_WALLET' AND user_id = $2`,
    [walletId, userId],
  );
  if (!rows[0]) throw errors.notFound('wallet');
  return rows[0];
}

export function registerWalletRoutes(ctx: Ctx): void {
  // GET /wallets/:id/balance -> 200
  ctx.app.get('/wallets/:id/balance', async (req) => {
    const actor = await authenticate(ctx, req, 'user');
    const w = await ownedWallet(ctx, pathId((req.params as { id: string }).id, 'wallet id'), (actor as { id: number }).id);
    return { wallet_id: w.id, balance: w.balance, currency: w.currency };
  });

  // GET /wallets/:id/statement -> 200
  //   newest first; ?limit=&offset=   (simple, but slow for deep pages - see README)
  //   or          ?limit=&cursor=     (keyset on (created_at, id) - same speed on every page)
  ctx.app.get('/wallets/:id/statement', async (req) => {
    const actor = await authenticate(ctx, req, 'user');
    const walletId = pathId((req.params as { id: string }).id, 'wallet id');
    await ownedWallet(ctx, walletId, (actor as { id: number }).id);

    const q = req.query as Record<string, string | undefined>;
    const limit = queryInt(q.limit, 'limit', 20, 1, 100);
    const offset = queryInt(q.offset, 'offset', 0, 0, 1_000_000);
    if (q.cursor !== undefined && q.offset !== undefined) {
      throw errors.validation('use either offset or cursor, not both');
    }

    const params: unknown[] = [walletId];
    let cursorSql = '';
    if (q.cursor !== undefined) {
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|(\d{1,15})$/.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (!m) throw errors.validation('cursor is not valid');
      params.push(m[1], Number(m[2]));
      cursorSql = 'AND (e.created_at, e.id) < ($2::timestamptz, $3::bigint)';
    }
    params.push(limit + 1); // fetch one extra row to know if there is a next page
    const limitIdx = params.length;
    let offsetSql = '';
    if (q.cursor === undefined && offset > 0) {
      params.push(offset);
      offsetSql = `OFFSET $${params.length}`;
    }

    const { rows } = await ctx.pool.query(
      `SELECT e.id, e.transfer_id, e.direction, e.amount,
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              t.type AS transfer_type, t.status AS transfer_status, t.note,
              CASE WHEN e.direction = 'D' THEN t.destination_account_id
                   ELSE t.source_account_id END AS counterparty_account_id
         FROM ledger_entries e
         JOIN transfers t ON t.id = e.transfer_id
        WHERE e.account_id = $1 ${cursorSql}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${limitIdx} ${offsetSql}`,
      params,
    );
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    const last = entries[entries.length - 1];
    return {
      entries,
      limit,
      offset: q.cursor === undefined ? offset : undefined,
      next_cursor: hasMore && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
    };
  });
}
