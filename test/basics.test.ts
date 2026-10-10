import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, ledgerTotals, makeApi, type Api } from './helpers/api';
import { createTestDb, type TestDb } from './helpers/db';

let db: TestDb;
let api: Api;
beforeAll(async () => {
  db = await createTestDb();
  api = await makeApi(db.pool);
});
afterAll(async () => db.drop());

describe('API contract basics', () => {
  it('creates users, wallets, tops up, transfers, withdraws; books stay balanced', async () => {
    const asha = await api.fundedUser('Asha', 100_000); // Rs 1,000
    const rahul = await api.fundedUser('Rahul', 0);

    const t = await api.post('/transfers', { from_wallet_id: asha.walletId, to_wallet_id: rahul.walletId, amount: 50_000, note: 'rent' }, { user: asha.userId });
    expect(t.status).toBe(201);
    expect(t.body.entries).toHaveLength(2);
    expect(t.body.entries.map((e: any) => e.direction).sort()).toEqual(['C', 'D']);

    expect(await balanceOf(db.pool, asha.walletId)).toBe(50_000);
    expect(await balanceOf(db.pool, rahul.walletId)).toBe(50_000);

    const w = await api.post('/transfers/withdraw', { wallet_id: rahul.walletId, amount: 20_000 }, { user: rahul.userId });
    expect(w.status).toBe(201);

    const bal = await api.get(`/wallets/${rahul.walletId}/balance`, { user: rahul.userId });
    expect(bal.body).toEqual({ wallet_id: rahul.walletId, balance: 30_000, currency: 'INR' });

    const totals = await ledgerTotals(db.pool);
    expect(totals.d).toBe(totals.c);

    const detail = await api.get(`/transfers/${t.body.id}`, { user: rahul.userId });
    expect(detail.status).toBe(200);
    expect(detail.body.entries).toHaveLength(2);
    expect(detail.body.status_history[0]).toMatchObject({ from_status: null, to_status: 'COMPLETED', changed_by: `user:${asha.userId}` });
  });

  it('rejects insufficient funds with 422 and writes nothing', async () => {
    const a = await api.fundedUser('Poor', 1_000);
    const b = await api.fundedUser('Other', 0);
    const before = await db.pool.query('SELECT count(*)::int AS n FROM transfers');
    const r = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_001 }, { user: a.userId });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_FUNDS');
    expect(r.body.request_id).toBeTruthy();
    const after = await db.pool.query('SELECT count(*)::int AS n FROM transfers');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await balanceOf(db.pool, a.walletId)).toBe(1_000);
  });

  it("does not let you spend from, or read, somebody else's wallet", async () => {
    const a = await api.fundedUser('A', 10_000);
    const b = await api.fundedUser('B', 10_000);
    const steal = await api.post('/transfers', { from_wallet_id: b.walletId, to_wallet_id: a.walletId, amount: 100 }, { user: a.userId });
    expect(steal.status).toBe(404);
    expect((await api.get(`/wallets/${b.walletId}/balance`, { user: a.userId })).status).toBe(404);
    expect((await api.get(`/wallets/${b.walletId}/balance`)).status).toBe(401);
    expect(await balanceOf(db.pool, b.walletId)).toBe(10_000);
  });

  it('validates input: floats, strings, zero, negatives, unknown wallet, same wallet', async () => {
    const a = await api.fundedUser('V', 10_000);
    const b = await api.fundedUser('W', 0);
    for (const amount of [1.5, '100', 0, -5, null, 2 ** 60]) {
      const r = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount }, { user: a.userId });
      expect(r.status, `amount=${String(amount)}`).toBe(422);
      expect(r.body.code).toBe('VALIDATION_ERROR');
    }
    expect((await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: a.walletId, amount: 1 }, { user: a.userId })).status).toBe(422);
    expect((await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: 999_999, amount: 1 }, { user: a.userId })).status).toBe(404);
  });

  it('returns the one error shape for unknown routes and bad JSON', async () => {
    const r = await api.get('/nope');
    expect(r.status).toBe(404);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'message', 'request_id']);
    const bad = await api.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json', 'idempotency-key': '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' }, payload: '{oops' });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json()).sort()).toEqual(['code', 'message', 'request_id']);
  });

  it('withdrawal fee produces a THREE-entry transfer that still balances', async () => {
    const feeApi = await makeApi(db.pool, undefined, { ...(await import('../src/config')).config, withdrawalFeePaise: 500 });
    const u = await feeApi.fundedUser('Fee', 100_000);
    const w = await feeApi.post('/transfers/withdraw', { wallet_id: u.walletId, amount: 10_000 }, { user: u.userId });
    expect(w.status).toBe(201);
    expect(w.body.entries).toHaveLength(3);
    expect(await balanceOf(db.pool, u.walletId)).toBe(100_000 - 10_500);
    const fee = await db.pool.query(`SELECT balance FROM accounts WHERE system_code = 'FEE_REVENUE'`);
    expect(fee.rows[0].balance).toBe(500);
    const totals = await ledgerTotals(db.pool);
    expect(totals.d).toBe(totals.c);
  });

  it('statement: newest first, offset and cursor pagination agree', async () => {
    const a = await api.fundedUser('Pager', 1_000_000);
    const b = await api.fundedUser('Sink', 0);
    for (let i = 1; i <= 25; i++) {
      await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: i * 100 }, { user: a.userId });
    }
    const page1 = await api.get(`/wallets/${a.walletId}/statement?limit=10`, { user: a.userId });
    expect(page1.body.entries).toHaveLength(10);
    expect(page1.body.entries[0].amount).toBe(2500); // newest first
    expect(page1.body.entries[0].direction).toBe('D');

    // walk everything by cursor
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await api.get(`/wallets/${a.walletId}/statement?limit=7${cursor ? `&cursor=${cursor}` : ''}`, { user: a.userId });
      seen.push(...r.body.entries.map((e: any) => e.id));
      cursor = r.body.next_cursor;
    } while (cursor);
    // same thing by offset
    const byOffset: number[] = [];
    for (let off = 0; off < 100; off += 7) {
      const r = await api.get(`/wallets/${a.walletId}/statement?limit=7&offset=${off}`, { user: a.userId });
      if (r.body.entries.length === 0) break;
      byOffset.push(...r.body.entries.map((e: any) => e.id));
    }
    expect(seen).toHaveLength(26); // 1 top-up + 25 transfers
    expect(new Set(seen).size).toBe(26);
    expect(byOffset).toEqual(seen);
    expect(seen).toEqual([...seen].sort((x, y) => y - x)); // strictly newest first
  });
});

describe('database guard rails (the schema protects itself)', () => {
  it('rejects a negative wallet balance, even when the app is bypassed', async () => {
    const a = await api.fundedUser('Guard', 100);
    await expect(db.pool.query('UPDATE accounts SET balance = -1 WHERE id = $1', [a.walletId])).rejects.toThrow(/accounts_wallet_nonnegative_ck/);
  });
  it('ledger entries cannot be updated, deleted or truncated', async () => {
    await expect(db.pool.query('UPDATE ledger_entries SET amount = amount + 1')).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
    await expect(db.pool.query('TRUNCATE ledger_entries CASCADE')).rejects.toThrow(/append-only/);
  });
  it('an unbalanced transfer cannot be committed', async () => {
    const a = await api.fundedUser('Unbal', 100);
    const t = await db.pool.query(
      `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id)
       VALUES ('PEER_TRANSFER','COMPLETED',10,$1,$2) RETURNING id`,
      [a.walletId, (await api.fundedUser('Dest', 0)).walletId],
    );
    await expect(
      db.pool.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1,$2,'D',10)`,
        [t.rows[0].id, a.walletId],
      ),
    ).rejects.toThrow(/unbalanced/);
  });
});
