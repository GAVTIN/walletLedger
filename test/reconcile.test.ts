import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginSnapshotAndLock, startReconciliation } from '../src/recon/reconcile';
import { seedData } from '../src/seed/generate';
import { balanceOf, makeApi, type Api } from './helpers/api';
import { createTestDb, type TestDb } from './helpers/db';

let db: TestDb;
let api: Api;
beforeAll(async () => {
  db = await createTestDb(20);
  api = await makeApi(db.pool);
});
afterAll(async () => db.drop());

const run = async () => {
  const r = await startReconciliation(db.pool, 'MANUAL');
  if (!r.started) throw new Error('could not start');
  return r.done;
};
const issuesOf = async (runId: number) =>
  (await db.pool.query(`SELECT check_name, subject_type, subject_id, expected, actual FROM reconciliation_issues WHERE run_id = $1 ORDER BY check_name, subject_id`, [runId])).rows;

/** Corrupt the books the way a bug or a rogue admin would: bypassing every trigger. */
async function corrupt(sql: (c: import('pg').PoolClient) => Promise<void>) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // superuser: disables triggers
    await sql(c);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

describe('Milestone 4 acceptance: seed 10,000 transfers, corrupt three things', () => {
  let walletA = 0, walletB = 0, walletC = 0, transferA = 0, transferB = 0;

  it('a clean ledger of 10,000 transfers reports NOTHING', async () => {
    const s = await seedData(db.pool, { users: 300, transfers: 10_000, seed: 7 });
    expect(s.transfers).toBe(10_000);
    expect(s.entries).toBe(20_000);

    const summary = await run();
    expect(summary).toMatchObject({ status: 'CLEAN', checksRun: 5, issuesFound: 0, entriesScanned: 20_000 });
    expect(await issuesOf(summary.runId)).toEqual([]);
  });

  it('after (a) changing one entry amount, (b) deleting one credit, (c) changing one stored balance, it reports exactly those', async () => {
    // (b) a credit we can delete without also pushing a wallet below zero
    const b = (
      await db.pool.query(
        `SELECT e.id, e.transfer_id, e.account_id FROM ledger_entries e
           JOIN accounts a ON a.id = e.account_id JOIN transfers t ON t.id = e.transfer_id
          WHERE e.direction = 'C' AND t.type = 'PEER_TRANSFER' AND a.kind = 'USER_WALLET' AND a.balance >= e.amount
          ORDER BY e.id OFFSET 300 LIMIT 1`,
      )
    ).rows[0];
    // (a) a different credit, on a different wallet and transfer; raising it can't overdraw anyone
    const a = (
      await db.pool.query(
        `SELECT e.id, e.transfer_id, e.account_id FROM ledger_entries e
           JOIN transfers t ON t.id = e.transfer_id JOIN accounts ac ON ac.id = e.account_id
          WHERE e.direction = 'C' AND t.type = 'PEER_TRANSFER' AND ac.kind = 'USER_WALLET'
            AND e.account_id <> $1 AND e.transfer_id <> $2
          ORDER BY e.id OFFSET 900 LIMIT 1`,
        [b.account_id, b.transfer_id],
      )
    ).rows[0];
    // (c) a third wallet whose stored balance we nudge
    const c = (
      await db.pool.query(`SELECT id FROM accounts WHERE kind = 'USER_WALLET' AND id NOT IN ($1, $2) ORDER BY id OFFSET 5 LIMIT 1`, [a.account_id, b.account_id])
    ).rows[0];
    walletA = a.account_id; walletB = b.account_id; walletC = c.id; transferA = a.transfer_id; transferB = b.transfer_id;

    await corrupt(async (cl) => {
      await cl.query('UPDATE ledger_entries SET amount = amount + 777 WHERE id = $1', [a.id]); // (a)
      await cl.query('DELETE FROM ledger_entries WHERE id = $1', [b.id]); // (b)
      await cl.query('UPDATE accounts SET balance = balance + 12345 WHERE id = $1', [c.id]); // (c)
    });

    const summary = await run();
    const issues = await issuesOf(summary.runId);
    const got = issues.map((i) => `${i.check_name}:${i.subject_id}`).sort();
    const want = [
      'GLOBAL_BALANCE:null',
      `TRANSFER_BALANCE:${transferA}`,
      `TRANSFER_BALANCE:${transferB}`,
      `STORED_BALANCE:${walletA}`,
      `STORED_BALANCE:${walletB}`,
      `STORED_BALANCE:${walletC}`,
    ].sort();

    // Three root causes surface through several checks (that is what the checks are FOR),
    // but nothing else is reported: no overdrafts, no orphans, no false positives.
    expect(got).toEqual(want);
    expect(summary.status).toBe('ISSUES_FOUND');
    expect(issues.filter((i) => i.check_name === 'NO_OVERDRAFT' || i.check_name === 'ORPHAN')).toEqual([]);

    // each row carries expected vs actual
    const stored = issues.find((i) => i.check_name === 'STORED_BALANCE' && i.subject_id === walletC)!;
    const real = await balanceOf(db.pool, walletC);
    expect(stored.actual).toBe(`balance = ${real}`);
    expect(stored.expected).toBe(`balance = ${real - 12345}`);
  });

  it('the job REPORTS but never FIXES: a second run finds the same problems and the data is untouched', async () => {
    const before = (await db.pool.query('SELECT balance FROM accounts WHERE id = $1', [walletC])).rows[0].balance;
    const again = await run();
    expect(again.issuesFound).toBe(6);
    const after = (await db.pool.query('SELECT balance FROM accounts WHERE id = $1', [walletC])).rows[0].balance;
    expect(after).toBe(before);
  });
});

describe('reconciliation behaviour', () => {
  it('only ONE run at a time: while the job_locks row is held, a new run exits', async () => {
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE`);
      const blocked = await startReconciliation(db.pool, 'CRON');
      expect(blocked).toEqual({ started: false, reason: 'ALREADY_RUNNING' });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const ok = await startReconciliation(db.pool, 'CRON');
    expect(ok.started).toBe(true);
    if (ok.started) await ok.done;
  });

  it('manual endpoint: 202 + run id, report is readable, admin token required', async () => {
    expect((await api.post('/admin/reconciliation/run', {})).status).toBe(401);
    const r = await api.post('/admin/reconciliation/run', {}, { admin: true });
    expect(r.status).toBe(202);
    expect(r.body.started).toBe(true);
    let report: any;
    for (let i = 0; i < 100; i++) {
      report = (await api.get(`/admin/reconciliation/runs/${r.body.run_id}`, { admin: true })).body;
      if (report.status !== 'RUNNING') break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(report.status).toBe('ISSUES_FOUND'); // the earlier corruption is still there
    expect(report.trigger).toBe('MANUAL');
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues[0]).toHaveProperty('expected');
    expect((await api.get('/admin/reconciliation/runs/999999', { admin: true })).status).toBe(404);
  });
});

describe('reconciliation on a live system', () => {
  it('the job connection reads ONE snapshot: transfers committed mid-run are invisible to later checks', async () => {
    const d = await createTestDb();
    try {
      const x = await makeApi(d.pool);
      const a = await x.fundedUser('SnapA', 100_000);
      const b = await x.fundedUser('SnapB', 0);
      const count = async (c: import('pg').PoolClient) => (await c.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n as number;

      // the job's own session setup (REPEATABLE READ + lock)
      const job = await d.pool.connect();
      try {
        expect(await beginSnapshotAndLock(job)).toBe(true);
        const first = await count(job);
        await x.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 500 }, { user: a.userId }); // commits mid-run
        expect(await count(job), 'same snapshot: still sees the old count').toBe(first);
      } finally {
        await job.query('ROLLBACK').catch(() => {});
        job.release();
      }

      // control: a READ COMMITTED session WOULD see the new rows between two queries
      const rc = await d.pool.connect();
      try {
        await rc.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const rcFirst = await count(rc);
        await x.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 500 }, { user: a.userId });
        expect(await count(rc)).toBe(rcFirst + 2);
      } finally {
        await rc.query('ROLLBACK').catch(() => {});
        rc.release();
      }
    } finally {
      await d.drop();
    }
  });

  it('reports no false positives while transfers commit concurrently', async () => {
    const live = await createTestDb(20);
    try {
      const liveApi = await makeApi(live.pool);
      const a = await liveApi.fundedUser('LiveA', 5_000_000);
      const b = await liveApi.fundedUser('LiveB', 5_000_000);
      let go = true;
      const load = (async () => {
        let i = 0;
        while (go) {
          const [from, to] = i++ % 2 ? [a, b] : [b, a];
          await Promise.all(
            Array.from({ length: 5 }, () => liveApi.post('/transfers', { from_wallet_id: from.walletId, to_wallet_id: to.walletId, amount: 100 }, { user: from.userId })),
          );
        }
      })();
      const statuses: string[] = [];
      for (let i = 0; i < 8; i++) {
        const r = await startReconciliation(live.pool, 'MANUAL');
        if (!r.started) throw new Error('lock busy');
        statuses.push((await r.done).status);
      }
      go = false;
      await load;
      expect(statuses).toEqual(Array(8).fill('CLEAN'));
    } finally {
      await live.drop();
    }
  });

  it('HELD and REJECTED transfers (which legitimately have no entries) are not reported as orphans', async () => {
    const d = await createTestDb();
    try {
      const x = await makeApi(d.pool);
      const a = await x.fundedUser('HA', 9_000_000);
      const b = await x.fundedUser('HB', 0);
      const held = await x.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 6_000_000 }, { user: a.userId });
      expect(held.status).toBe(202);
      await x.post(`/admin/risk/${held.body.id}/decision`, { decision: 'reverse' }, { admin: true }); // REJECTED
      await x.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 6_000_000 }, { user: a.userId }); // another HELD
      const r = await startReconciliation(d.pool, 'MANUAL');
      if (!r.started) throw new Error('lock busy');
      expect((await r.done).status).toBe('CLEAN');
    } finally {
      await d.drop();
    }
  });
});
