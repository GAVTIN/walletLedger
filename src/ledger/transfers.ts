import type { Client } from '../db';
import { AppError, errors } from '../errors';
import { evaluateRules, recordFlags, type Fired } from '../risk/rules';
import { actorLabel, type AccountRow, type Actor, type EntryRow, type Leg, type TransferRow } from '../types';

/**
 * THE MONEY PATH.
 *
 * Every function here expects to be called INSIDE a transaction that somebody
 * else began (the idempotency wrapper in src/http/idempotency.ts). The rule of
 * the house is: one transaction = one transfer = all-or-nothing.
 *
 * Isolation level: READ COMMITTED (the Postgres default) + explicit row locks.
 * Why that is enough - and why we don't pay for SERIALIZABLE - is explained in
 * the README ("Which isolation level?"). Short version: we lock exactly the rows
 * whose values we are about to read-then-write, so nothing can change under us;
 * a lost update or overdraft is impossible. Serializable would also be correct
 * but would abort transactions with 40001 and force retries under contention.
 */

// --------------------------------------------------------------- helpers ----

export type SystemAccounts = { CASH_IN: number; CASH_OUT: number; FEE_REVENUE: number };

export async function systemAccounts(client: Client): Promise<SystemAccounts> {
  const { rows } = await client.query<{ id: number; system_code: keyof SystemAccounts }>(
    'SELECT id, system_code FROM accounts WHERE system_code IS NOT NULL',
  );
  const out = {} as SystemAccounts;
  for (const r of rows) out[r.system_code] = r.id;
  return out;
}

/**
 * Lock the given account rows, ALWAYS in ascending id order.
 *
 * If transfer 1 locked A then B while transfer 2 locked B then A, each would
 * wait for the other forever (deadlock). One global order makes a cycle
 * impossible. `ORDER BY id FOR UPDATE` locks rows in sorted order because the
 * LockRows plan node sits above the Sort node.
 */
export async function lockAccounts(client: Client, ids: number[]): Promise<Map<number, AccountRow>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const { rows } = await client.query<AccountRow>(
    `SELECT id, kind, user_id, balance
       FROM accounts
      WHERE id = ANY($1::bigint[])
      ORDER BY id
        FOR UPDATE`,
    [unique],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Net effect of legs on each account: credits add, debits subtract. */
function netByAccount(legs: Leg[]): Map<number, number> {
  const net = new Map<number, number>();
  for (const l of legs) {
    net.set(l.accountId, (net.get(l.accountId) ?? 0) + (l.direction === 'C' ? l.amount : -l.amount));
  }
  return net;
}

/**
 * Re-check balances WHILE HOLDING THE LOCK. This is the step the naive version
 * gets wrong: it reads the balance before anyone has locked the row, so by the
 * time it writes, the number it checked is stale.
 * (The CHECK constraint on accounts is the backstop if this code is ever wrong.)
 */
function assertNoOverdraft(accounts: Map<number, AccountRow>, legs: Leg[]): void {
  for (const [accountId, delta] of netByAccount(legs)) {
    const acc = accounts.get(accountId)!;
    if (acc.kind === 'USER_WALLET' && acc.balance + delta < 0) throw errors.insufficientFunds();
  }
}

async function insertTransferRow(
  client: Client,
  t: {
    type: TransferRow['type'];
    status: TransferRow['status'];
    amount: number;
    fee: number;
    sourceId: number;
    destId: number;
    userId: number | null;
    reversesId?: number | null;
    note?: string | null;
  },
): Promise<TransferRow> {
  const { rows } = await client.query<TransferRow>(
    `INSERT INTO transfers
       (type, status, amount, fee, source_account_id, destination_account_id,
        initiated_by_user_id, reverses_transfer_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [t.type, t.status, t.amount, t.fee, t.sourceId, t.destId, t.userId, t.reversesId ?? null, t.note ?? null],
  );
  return rows[0];
}

export async function addHistory(
  client: Client,
  transferId: number,
  from: string | null,
  to: string,
  by: string,
  reason?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO transfer_status_history (transfer_id, from_status, to_status, changed_by, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [transferId, from, to, by, reason ?? null],
  );
}

/**
 * Write the ledger lines and move the stored balances. Called only while the
 * account rows are locked and funds have been verified.
 */
async function postLegs(
  client: Client,
  transferId: number,
  legs: Leg[],
): Promise<EntryRow[]> {
  const params: unknown[] = [];
  const values = legs.map((l, i) => {
    params.push(transferId, l.accountId, l.direction, l.amount);
    const o = i * 4;
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`;
  });
  const { rows: entries } = await client.query<EntryRow>(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
     VALUES ${values.join(', ')}
     RETURNING *`,
    params,
  );
  for (const [accountId, delta] of netByAccount(legs)) {
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [delta, accountId]);
  }
  return entries;
}

async function assertKycNotRejected(client: Client, userId: number): Promise<void> {
  const { rows } = await client.query<{ kyc_status: string }>(
    'SELECT kyc_status FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw errors.notFound('user');
  if (rows[0].kyc_status === 'REJECTED') {
    throw new AppError(403, 'KYC_REJECTED', 'This user failed KYC and cannot move money');
  }
}

// ------------------------------------------------------- create transfer ----

export type NewTransfer =
  | { type: 'TOPUP'; userId: number; walletId: number; amount: number; note?: string | null }
  | { type: 'PEER_TRANSFER'; userId: number; fromWalletId: number; toWalletId: number; amount: number; note?: string | null }
  | { type: 'WITHDRAWAL'; userId: number; walletId: number; amount: number; fee: number; note?: string | null };

export type TransferOutcome = {
  held: boolean;
  transfer: TransferRow;
  entries: EntryRow[];
  fired: Fired[];
};

export async function createTransfer(client: Client, p: NewTransfer): Promise<TransferOutcome> {
  const sys = await systemAccounts(client);

  let sourceId: number;
  let destId: number;
  let fee = 0;
  if (p.type === 'TOPUP') {
    sourceId = sys.CASH_IN;
    destId = p.walletId;
  } else if (p.type === 'PEER_TRANSFER') {
    sourceId = p.fromWalletId;
    destId = p.toWalletId;
  } else {
    sourceId = p.walletId;
    destId = sys.CASH_OUT;
    fee = p.fee;
  }
  if (sourceId === destId) throw errors.validation('source and destination wallet must differ');

  await assertKycNotRejected(client, p.userId);

  // ---- 1. LOCK both (all) account rows, in ascending id order ----------------
  const lockIds = [sourceId, destId];
  if (fee > 0) lockIds.push(sys.FEE_REVENUE);
  const accounts = await lockAccounts(client, lockIds);

  // ---- 2. Authorise using the locked rows -----------------------------------
  const source = accounts.get(sourceId);
  const dest = accounts.get(destId);
  const ownsWallet = (a: AccountRow | undefined) => a?.kind === 'USER_WALLET' && a.user_id === p.userId;
  if (p.type === 'TOPUP' && !ownsWallet(dest)) throw errors.notFound('wallet');
  if (p.type === 'PEER_TRANSFER') {
    if (!ownsWallet(source)) throw errors.notFound('source wallet');
    if (!dest || dest.kind !== 'USER_WALLET') throw errors.notFound('destination wallet');
  }
  if (p.type === 'WITHDRAWAL' && !ownsWallet(source)) throw errors.notFound('wallet');

  // ---- 3. Build the double-entry legs ---------------------------------------
  const legs: Leg[] =
    p.type === 'TOPUP'
      ? [
          { accountId: sourceId, direction: 'D', amount: p.amount },
          { accountId: destId, direction: 'C', amount: p.amount },
        ]
      : p.type === 'PEER_TRANSFER'
        ? [
            { accountId: sourceId, direction: 'D', amount: p.amount },
            { accountId: destId, direction: 'C', amount: p.amount },
          ]
        : [
            { accountId: sourceId, direction: 'D', amount: p.amount + fee },
            { accountId: destId, direction: 'C', amount: p.amount },
            ...(fee > 0 ? [{ accountId: sys.FEE_REVENUE, direction: 'C' as const, amount: fee }] : []),
          ];

  // ---- 4. Re-read the balance under the lock; reject if not enough ----------
  assertNoOverdraft(accounts, legs);

  // ---- 5. Fraud rules (still inside the transaction, before any money moves) -
  const fired =
    p.type === 'TOPUP'
      ? []
      : await evaluateRules(client, { type: p.type, sourceId, destId, amount: p.amount });
  const hold = fired.some((f) => f.action === 'HOLD');

  const row = {
    type: p.type,
    amount: p.amount,
    fee,
    sourceId,
    destId,
    userId: p.userId,
    note: p.note ?? null,
  };

  if (hold) {
    // A held transfer moves NO money: no entries, no balance change.
    const transfer = await insertTransferRow(client, { ...row, status: 'HELD' });
    await addHistory(client, transfer.id, null, 'HELD', actorLabel({ kind: 'user', id: p.userId }), 'held by risk rules');
    await recordFlags(client, transfer.id, fired, true);
    return { held: true, transfer, entries: [], fired };
  }

  // ---- 6. Insert the transfer + balanced entries, update stored balances ----
  const transfer = await insertTransferRow(client, { ...row, status: 'COMPLETED' });
  await addHistory(client, transfer.id, null, 'COMPLETED', actorLabel({ kind: 'user', id: p.userId }));
  const entries = await postLegs(client, transfer.id, legs);
  await recordFlags(client, transfer.id, fired, false);
  return { held: false, transfer, entries, fired };
  // ---- 7. COMMIT happens in the caller. Any throw above => ROLLBACK, no trace.
}

// ------------------------------------------------------------- reversal ----

/**
 * A mistake is fixed with a NEW transfer that points to the original and mirrors
 * its entries (every debit becomes a credit and vice versa). The original entries
 * are never touched.
 */
export async function reverseTransfer(
  client: Client,
  originalId: number,
  actor: Actor,
  reason?: string,
): Promise<{ transfer: TransferRow; entries: EntryRow[] }> {
  // Lock the original first. A concurrent second reversal waits here, then sees
  // status = REVERSED and gets a 409. (The unique index on reverses_transfer_id
  // is the backstop.)
  const { rows } = await client.query<TransferRow>('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [originalId]);
  const orig = rows[0];
  if (!orig) throw errors.notFound('transfer');
  if (actor.kind === 'user' && orig.initiated_by_user_id !== actor.id) throw errors.notFound('transfer');
  if (orig.type === 'REVERSAL') throw errors.conflict('NOT_REVERSIBLE', 'A reversal cannot itself be reversed');
  if (orig.status === 'REVERSED') throw errors.conflict('ALREADY_REVERSED', 'This transfer was already reversed');
  if (orig.status !== 'COMPLETED') {
    throw errors.conflict('NOT_REVERSIBLE', `Only COMPLETED transfers can be reversed (status is ${orig.status})`);
  }

  const { rows: origEntries } = await client.query<EntryRow>(
    'SELECT * FROM ledger_entries WHERE transfer_id = $1 ORDER BY id',
    [originalId],
  );
  const legs: Leg[] = origEntries.map((e) => ({
    accountId: e.account_id,
    direction: e.direction === 'D' ? 'C' : 'D',
    amount: e.amount,
  }));

  const accounts = await lockAccounts(client, legs.map((l) => l.accountId));
  // e.g. Asha paid Rahul Rs 500, Rahul spent it: reversing would overdraw Rahul.
  assertNoOverdraft(accounts, legs);

  const transfer = await insertTransferRow(client, {
    type: 'REVERSAL',
    status: 'COMPLETED',
    amount: orig.amount,
    fee: orig.fee,
    sourceId: orig.destination_account_id,
    destId: orig.source_account_id,
    userId: actor.kind === 'user' ? actor.id : null,
    reversesId: orig.id,
    note: reason ? `reversal: ${reason}`.slice(0, 280) : null,
  });
  await addHistory(client, transfer.id, null, 'COMPLETED', actorLabel(actor), reason);
  const entries = await postLegs(client, transfer.id, legs);

  await client.query(`UPDATE transfers SET status = 'REVERSED' WHERE id = $1`, [orig.id]);
  await addHistory(client, orig.id, 'COMPLETED', 'REVERSED', actorLabel(actor), reason);
  return { transfer, entries };
}

// ------------------------------------------------------- held: decisions ----

/** Release a HELD transfer: now (and only now) the money actually moves. */
export async function releaseHeld(
  client: Client,
  transferId: number,
  actor: Actor,
  reason?: string,
): Promise<{ transfer: TransferRow; entries: EntryRow[] }> {
  const { rows } = await client.query<TransferRow>('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId]);
  const t = rows[0];
  if (!t) throw errors.notFound('transfer');
  if (t.status !== 'HELD') throw errors.conflict('NOT_HELD', `Transfer is ${t.status}, not HELD`);

  const sys = await systemAccounts(client);
  const legs: Leg[] = [
    { accountId: t.source_account_id, direction: 'D', amount: t.amount + t.fee },
    { accountId: t.destination_account_id, direction: 'C', amount: t.amount },
    ...(t.fee > 0 ? [{ accountId: sys.FEE_REVENUE, direction: 'C' as const, amount: t.fee }] : []),
  ];
  const accounts = await lockAccounts(client, legs.map((l) => l.accountId));
  assertNoOverdraft(accounts, legs); // the sender may have spent the money meanwhile

  await client.query(`UPDATE transfers SET status = 'COMPLETED' WHERE id = $1`, [t.id]);
  await addHistory(client, t.id, 'HELD', 'COMPLETED', actorLabel(actor), reason ?? 'released by admin');
  const entries = await postLegs(client, t.id, legs);
  await client.query(
    `UPDATE risk_flags SET reviewed_at = now(), reviewed_by = $2 WHERE transfer_id = $1 AND reviewed_at IS NULL`,
    [t.id, actorLabel(actor)],
  );
  return { transfer: { ...t, status: 'COMPLETED' }, entries };
}

/** Refuse a HELD transfer. No money ever moved, so there is nothing to undo. */
export async function rejectHeld(
  client: Client,
  transferId: number,
  actor: Actor,
  reason?: string,
): Promise<{ transfer: TransferRow; entries: EntryRow[] }> {
  const { rows } = await client.query<TransferRow>('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId]);
  const t = rows[0];
  if (!t) throw errors.notFound('transfer');
  if (t.status !== 'HELD') throw errors.conflict('NOT_HELD', `Transfer is ${t.status}, not HELD`);
  await client.query(`UPDATE transfers SET status = 'REJECTED' WHERE id = $1`, [t.id]);
  await addHistory(client, t.id, 'HELD', 'REJECTED', actorLabel(actor), reason ?? 'rejected by admin');
  await client.query(
    `UPDATE risk_flags SET reviewed_at = now(), reviewed_by = $2 WHERE transfer_id = $1 AND reviewed_at IS NULL`,
    [t.id, actorLabel(actor)],
  );
  return { transfer: { ...t, status: 'REJECTED' }, entries: [] };
}

/** Admin "release" of an already-COMPLETED flagged transfer: just mark it reviewed. */
export async function markFlagsReviewed(client: Client, transferId: number, actor: Actor): Promise<void> {
  await client.query(
    `UPDATE risk_flags SET reviewed_at = now(), reviewed_by = $2 WHERE transfer_id = $1 AND reviewed_at IS NULL`,
    [transferId, actorLabel(actor)],
  );
}
