import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, ledgerTotals, makeApi, type Api } from './helpers/api';
import { createTestDb, type TestDb } from './helpers/db';

let db: TestDb;
let api: Api;
beforeAll(async () => {
  db = await createTestDb(20);
  api = await makeApi(db.pool);
});
afterAll(async () => db.drop());

/**
 * Milestone 2 acceptance test: Rs 500 in one wallet, 100 concurrent Rs 10
 * transfers out of it. A race that fails once in 20 runs is still a bug, so we
 * run the whole thing 20 times in a row.
 */
describe('stampede: 100 concurrent Rs 10 transfers out of a Rs 500 wallet', () => {
  for (let run = 1; run <= 20; run++) {
    it(`run ${run}/20`, async () => {
      const src = await api.fundedUser(`Src${run}`, 50_000); // Rs 500
      const dst = await api.fundedUser(`Dst${run}`, 0);

      // Watch the balance from the outside while the stampede runs: it must never dip below 0.
      let watching = true;
      let minSeen = Number.POSITIVE_INFINITY;
      const watcher = (async () => {
        while (watching) {
          minSeen = Math.min(minSeen, await balanceOf(db.pool, src.walletId));
          await new Promise((r) => setTimeout(r, 2));
        }
      })();

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          api.post('/transfers', { from_wallet_id: src.walletId, to_wallet_id: dst.walletId, amount: 1_000 }, { user: src.userId }),
        ),
      );
      watching = false;
      await watcher;

      const ok = results.filter((r) => r.status === 201).length;
      const rejected = results.filter((r) => r.status === 422 && r.body.code === 'INSUFFICIENT_FUNDS').length;
      expect(ok, 'exactly 50 transfers succeed').toBe(50);
      expect(rejected, 'the other 50 are cleanly rejected').toBe(50);

      expect(await balanceOf(db.pool, src.walletId), 'wallet ends at Rs 0').toBe(0);
      expect(await balanceOf(db.pool, dst.walletId)).toBe(50_000);
      expect(minSeen, 'never negative').toBeGreaterThanOrEqual(0);

      // the ledger agrees with the stored balance, and the books balance
      const computed = await db.pool.query<{ b: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction='C' THEN amount ELSE -amount END),0) AS b FROM ledger_entries WHERE account_id = $1`,
        [src.walletId],
      );
      expect(computed.rows[0].b).toBe(0);
      const totals = await ledgerTotals(db.pool);
      expect(totals.d, 'total debits equal total credits').toBe(totals.c);
    });
  }
});

describe('deadlock freedom', () => {
  it('opposite-direction transfers between the same two wallets never deadlock', async () => {
    const a = await api.fundedUser('A', 1_000_000);
    const b = await api.fundedUser('B', 1_000_000);
    const jobs = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0
        ? api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 }, { user: a.userId })
        : api.post('/transfers', { from_wallet_id: b.walletId, to_wallet_id: a.walletId, amount: 100 }, { user: b.userId }),
    );
    const res = await Promise.all(jobs);
    expect(res.filter((r) => r.status !== 201 && r.status !== 202).map((r) => r.raw)).toEqual([]);
    expect((await balanceOf(db.pool, a.walletId)) + (await balanceOf(db.pool, b.walletId))).toBe(2_000_000);
  });
});

describe('reversals', () => {
  it('reverse restores balances with a NEW transfer; original entries untouched; second reverse is 409', async () => {
    const a = await api.fundedUser('RevA', 100_000);
    const b = await api.fundedUser('RevB', 0);
    const t = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 30_000 }, { user: a.userId });
    const before = (await db.pool.query('SELECT * FROM ledger_entries WHERE transfer_id = $1 ORDER BY id', [t.body.id])).rows;

    const r = await api.post(`/transfers/${t.body.id}/reverse`, { reason: 'sent by mistake' }, { user: a.userId });
    expect(r.status).toBe(201);
    expect(r.body.type).toBe('REVERSAL');
    expect(r.body.reverses_transfer_id).toBe(t.body.id);
    expect(await balanceOf(db.pool, a.walletId)).toBe(100_000);
    expect(await balanceOf(db.pool, b.walletId)).toBe(0);

    const after = (await db.pool.query('SELECT * FROM ledger_entries WHERE transfer_id = $1 ORDER BY id', [t.body.id])).rows;
    expect(after).toEqual(before);
    const orig = await api.get(`/transfers/${t.body.id}`, { user: a.userId });
    expect(orig.body.status).toBe('REVERSED');
    expect(orig.body.status_history.map((h: any) => h.to_status)).toEqual(['COMPLETED', 'REVERSED']);

    const again = await api.post(`/transfers/${t.body.id}/reverse`, {}, { user: a.userId });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_REVERSED');
  });

  it('concurrent double reversal: exactly one wins', async () => {
    const a = await api.fundedUser('RA', 100_000);
    const b = await api.fundedUser('RB', 0);
    const t = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 10_000 }, { user: a.userId });
    const res = await Promise.all(Array.from({ length: 8 }, () => api.post(`/transfers/${t.body.id}/reverse`, {}, { user: a.userId })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await balanceOf(db.pool, a.walletId)).toBe(100_000);
  });

  it("cannot reverse a transfer whose money the receiver already spent (422, nothing changes)", async () => {
    const a = await api.fundedUser('SA', 50_000);
    const b = await api.fundedUser('SB', 0);
    const c = await api.fundedUser('SC', 0);
    const t = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 50_000 }, { user: a.userId });
    await api.post('/transfers', { from_wallet_id: b.walletId, to_wallet_id: c.walletId, amount: 50_000 }, { user: b.userId });
    const r = await api.post(`/transfers/${t.body.id}/reverse`, {}, { user: a.userId });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_FUNDS');
    expect((await api.get(`/transfers/${t.body.id}`, { user: a.userId })).body.status).toBe('COMPLETED');
  });

  it('only the initiator may reverse', async () => {
    const a = await api.fundedUser('IA', 50_000);
    const b = await api.fundedUser('IB', 0);
    const t = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000 }, { user: a.userId });
    expect((await api.post(`/transfers/${t.body.id}/reverse`, {}, { user: b.userId })).status).toBe(404);
  });
});
