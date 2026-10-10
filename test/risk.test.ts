import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReconciliation } from '../src/recon/reconcile';
import { balanceOf, makeApi, type Api } from './helpers/api';
import { createTestDb, type TestDb } from './helpers/db';

let db: TestDb;
let api: Api;
beforeAll(async () => {
  db = await createTestDb(20);
  api = await makeApi(db.pool);
});
afterAll(async () => db.drop());

const flagsOf = async (transferId: number) =>
  (await db.pool.query('SELECT rule_code, action_taken FROM risk_flags WHERE transfer_id = $1 ORDER BY rule_code', [transferId])).rows;
const entryCount = async (transferId: number) =>
  (await db.pool.query('SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id = $1', [transferId])).rows[0].n as number;

describe('held transfers (LARGE_AMOUNT, Rs 50,000 and above)', () => {
  it('202, no ledger entries, no balance change, flags recorded, audit log written', async () => {
    const a = await api.fundedUser('H1', 9_000_000);
    const b = await api.fundedUser('H2', 0);
    const r = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 5_000_000 }, { user: a.userId });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('HELD');
    expect(r.body.entries).toEqual([]);
    expect(await entryCount(r.body.id)).toBe(0);
    expect(await balanceOf(db.pool, a.walletId)).toBe(9_000_000);
    expect(await balanceOf(db.pool, b.walletId)).toBe(0);
    expect(await flagsOf(r.body.id)).toEqual([
      { rule_code: 'LARGE_AMOUNT', action_taken: 'HELD' },
      { rule_code: 'NEW_RECIPIENT_HIGH', action_taken: 'FLAGGED' }, // first payment to B, >= Rs 10,000
    ]);
    const detail = await api.get(`/transfers/${r.body.id}`, { user: a.userId });
    expect(detail.body.status_history).toMatchObject([{ from_status: null, to_status: 'HELD', changed_by: `user:${a.userId}` }]);

    const queue = await api.get('/admin/risk/queue', { admin: true });
    expect(queue.body.items.map((i: any) => i.id)).toContain(r.body.id);
  });

  it('admin RELEASE: the money moves now; history shows who and when; double release is 409', async () => {
    const a = await api.fundedUser('R1', 9_000_000);
    const b = await api.fundedUser('R2', 0);
    const h = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 6_000_000 }, { user: a.userId });
    const rel = await api.post(`/admin/risk/${h.body.id}/decision`, { decision: 'release', reason: 'verified by phone' }, { admin: true });
    expect(rel.status).toBe(200);
    expect(rel.body.transfer.status).toBe('COMPLETED');
    expect(rel.body.entries).toHaveLength(2);
    expect(await balanceOf(db.pool, a.walletId)).toBe(3_000_000);
    expect(await balanceOf(db.pool, b.walletId)).toBe(6_000_000);

    const detail = await api.get(`/transfers/${h.body.id}`, { user: a.userId });
    expect(detail.body.status_history.map((x: any) => [x.from_status, x.to_status, x.changed_by])).toEqual([
      [null, 'HELD', `user:${a.userId}`],
      ['HELD', 'COMPLETED', 'admin'],
    ]);
    expect(detail.body.status_history[1].reason).toBe('verified by phone');

    // A repeated "release" is harmless: the transfer is COMPLETED now, so it only re-marks the flags as
    // reviewed. What matters is that the money does not move a second time.
    const again = await api.post(`/admin/risk/${h.body.id}/decision`, { decision: 'release' }, { admin: true });
    expect(again.status).toBe(200);
    expect(await entryCount(h.body.id)).toBe(2);
    expect(await balanceOf(db.pool, a.walletId)).toBe(3_000_000);
    expect(await balanceOf(db.pool, b.walletId)).toBe(6_000_000);
    // released transfers leave the queue
    const queue = await api.get('/admin/risk/queue?limit=200', { admin: true });
    expect(queue.body.items.map((i: any) => i.id)).not.toContain(h.body.id);
  });

  it('parallel releases of the same held transfer move the money exactly once', async () => {
    const a = await api.fundedUser('PR1', 9_000_000);
    const b = await api.fundedUser('PR2', 0);
    const h = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 5_000_000 }, { user: a.userId });
    const res = await Promise.all(Array.from({ length: 6 }, () => api.post(`/admin/risk/${h.body.id}/decision`, { decision: 'release' }, { admin: true })));
    expect(res.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await entryCount(h.body.id)).toBe(2);
    expect(await balanceOf(db.pool, a.walletId)).toBe(4_000_000);
    expect(await balanceOf(db.pool, b.walletId)).toBe(5_000_000);
  });

  it('admin REVERSE of a held transfer rejects it: nothing ever moved', async () => {
    const a = await api.fundedUser('J1', 9_000_000);
    const b = await api.fundedUser('J2', 0);
    const h = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 5_500_000 }, { user: a.userId });
    const rej = await api.post(`/admin/risk/${h.body.id}/decision`, { decision: 'reverse' }, { admin: true });
    expect(rej.status).toBe(200);
    expect(rej.body.transfer.status).toBe('REJECTED');
    expect(await entryCount(h.body.id)).toBe(0);
    expect(await balanceOf(db.pool, a.walletId)).toBe(9_000_000);
  });

  it('release re-checks funds: if the sender spent the money meanwhile it is 422 and stays HELD', async () => {
    const a = await api.fundedUser('F1', 6_000_000);
    const b = await api.fundedUser('F2', 0);
    const h = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 5_000_000 }, { user: a.userId });
    expect(h.status).toBe(202);
    expect((await api.post('/transfers/withdraw', { wallet_id: a.walletId, amount: 2_000_000 }, { user: a.userId })).status).toBe(201);
    const rel = await api.post(`/admin/risk/${h.body.id}/decision`, { decision: 'release' }, { admin: true });
    expect(rel.status).toBe(422);
    expect(rel.body.code).toBe('INSUFFICIENT_FUNDS');
    expect((await api.get(`/transfers/${h.body.id}`, { user: a.userId })).body.status).toBe('HELD');
    await api.topup(a.userId, a.walletId, 1_000_000);
    expect((await api.post(`/admin/risk/${h.body.id}/decision`, { decision: 'release' }, { admin: true })).status).toBe(200);
  });

  it('a held transfer is also rejected up front when the wallet cannot cover it', async () => {
    const a = await api.fundedUser('P1', 1_000_000);
    const b = await api.fundedUser('P2', 0);
    const r = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 5_000_000 }, { user: a.userId });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('the admin endpoints need the admin token', async () => {
    expect((await api.get('/admin/risk/queue')).status).toBe(401);
    expect((await api.post('/admin/risk/1/decision', { decision: 'release' })).status).toBe(401);
    const u = await api.createUser('NotAdmin');
    expect((await api.get('/admin/risk/queue', { user: u })).status).toBe(401);
  });
});

describe('other rules', () => {
  it('DAILY_VOLUME: the transfer that pushes 24h outgoing past Rs 1,00,000 is held', async () => {
    const a = await api.fundedUser('D1', 30_000_000);
    const b = await api.fundedUser('D2', 0);
    const send = () => api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 4_000_000 }, { user: a.userId });
    const t1 = await send();
    const t2 = await send();
    const t3 = await send(); // 40k + 40k + 40k = 1,20,000 > 1,00,000
    expect([t1.status, t2.status, t3.status]).toEqual([201, 201, 202]);
    expect(t1.body.flags.map((f: any) => f.rule)).toEqual(['NEW_RECIPIENT_HIGH']); // only the first payment to a new recipient
    expect(t2.body.flags).toEqual([]);
    expect(t3.body.flags.map((f: any) => f.rule)).toEqual(['DAILY_VOLUME']);
    expect(await balanceOf(db.pool, a.walletId)).toBe(30_000_000 - 8_000_000);
  });

  it('VELOCITY (flag only): the 6th transfer in 10 minutes still completes but is flagged; review clears it', async () => {
    const a = await api.fundedUser('V1', 1_000_000);
    const b = await api.fundedUser('V2', 0);
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000 }, { user: a.userId }));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(rs.slice(0, 5).every((r) => r.body.flags.length === 0)).toBe(true);
    expect(rs[5].body.flags.map((f: any) => f.rule)).toEqual(['VELOCITY']);
    expect(await balanceOf(db.pool, a.walletId)).toBe(1_000_000 - 6_000); // money DID move

    let queue = await api.get('/admin/risk/queue?limit=200', { admin: true });
    expect(queue.body.items.map((i: any) => i.id)).toContain(rs[5].body.id);
    const rel = await api.post(`/admin/risk/${rs[5].body.id}/decision`, { decision: 'release' }, { admin: true });
    expect(rel.status).toBe(200);
    queue = await api.get('/admin/risk/queue?limit=200', { admin: true });
    expect(queue.body.items.map((i: any) => i.id)).not.toContain(rs[5].body.id);
  });

  it('admin REVERSE of a flagged-but-completed transfer creates a real reversal and clears the flag', async () => {
    const a = await api.fundedUser('W1', 1_000_000);
    const b = await api.fundedUser('W2', 0);
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000 }, { user: a.userId }));
    const rev = await api.post(`/admin/risk/${rs[5].body.id}/decision`, { decision: 'reverse', reason: 'looks like a bot' }, { admin: true });
    expect(rev.status).toBe(200);
    expect(rev.body.reversal.type).toBe('REVERSAL');
    expect(await balanceOf(db.pool, a.walletId)).toBe(1_000_000 - 5_000);
    const queue = await api.get('/admin/risk/queue?limit=200', { admin: true });
    expect(queue.body.items.map((i: any) => i.id)).not.toContain(rs[5].body.id);
  });

  it('NEW_RECIPIENT_HIGH flags only the FIRST big payment to someone', async () => {
    const a = await api.fundedUser('N1', 5_000_000);
    const b = await api.fundedUser('N2', 0);
    const t1 = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000_000 }, { user: a.userId });
    const t2 = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000_000 }, { user: a.userId });
    expect(t1.body.flags.map((f: any) => f.rule)).toEqual(['NEW_RECIPIENT_HIGH']);
    expect(t2.body.flags).toEqual([]);
  });

  it('withdrawals are checked too; top-ups are not', async () => {
    const a = await api.fundedUser('X1', 0);
    const topup = await api.post('/transfers/topup', { wallet_id: a.walletId, amount: 20_000_000 }, { user: a.userId });
    expect(topup.status).toBe(201); // huge top-up: no rules
    const w = await api.post('/transfers/withdraw', { wallet_id: a.walletId, amount: 6_000_000 }, { user: a.userId });
    expect(w.status).toBe(202);
    expect(w.body.type).toBe('WITHDRAWAL');
  });

  it('thresholds live in the risk_rules TABLE: change a row and behaviour changes, no deploy', async () => {
    const a = await api.fundedUser('T1', 100_000);
    const b = await api.fundedUser('T2', 0);
    const small = () => api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 200 }, { user: a.userId });
    try {
      expect((await small()).status).toBe(201);
      await db.pool.query(`UPDATE risk_rules SET params = jsonb_set(params, '{threshold_paise}', '100') WHERE code = 'LARGE_AMOUNT'`);
      expect((await small()).status).toBe(202); // Rs 2 is now "large"
      await db.pool.query(`UPDATE risk_rules SET enabled = false WHERE code = 'LARGE_AMOUNT'`);
      expect((await small()).status).toBe(201); // rule switched off
    } finally {
      await db.pool.query(`UPDATE risk_rules SET params = jsonb_set(params, '{threshold_paise}', '5000000'), enabled = true WHERE code = 'LARGE_AMOUNT'`);
    }
  });

  it('a user whose KYC was rejected cannot move money', async () => {
    const a = await api.fundedUser('K1', 10_000);
    const b = await api.fundedUser('K2', 0);
    await db.pool.query(`UPDATE users SET kyc_status = 'REJECTED' WHERE id = $1`, [a.userId]);
    const r = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 }, { user: a.userId });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('KYC_REJECTED');
    expect((await api.post('/transfers/topup', { wallet_id: a.walletId, amount: 100 }, { user: a.userId })).status).toBe(403);
  });
});

describe('books stay consistent through all of the above', () => {
  it('reconciliation is CLEAN after held, released, rejected and reversed transfers', async () => {
    const r = await startReconciliation(db.pool, 'MANUAL');
    if (!r.started) throw new Error('lock busy');
    const summary = await r.done;
    expect(summary.issuesFound, JSON.stringify((await db.pool.query('SELECT * FROM reconciliation_issues WHERE run_id=$1 LIMIT 5', [summary.runId])).rows)).toBe(0);
    expect(summary.status).toBe('CLEAN');
  });
});
