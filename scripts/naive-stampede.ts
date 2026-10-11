/**
 * Milestone 2, step 2: BREAK IT FIRST.
 *
 * A deliberately naive transfer (read balance, check in code, write) - no row locks -
 * hit with the stampede: Rs 500 in one wallet, 100 concurrent Rs 10 transfers.
 * Then the same stampede against the real, locked implementation, for comparison.
 * After each, the nightly reconciliation job audits the books.
 *
 *   npm run lab:naive        (writes docs/naive-stampede.md)
 */
import '../src/env';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../src/config';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/db/migrate';
import { startReconciliation } from '../src/recon/reconcile';
import { makeApi } from '../test/helpers/api';

const ADMIN = process.env.LAB_ADMIN_URL ?? process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rs = (paise: number) => `Rs ${(paise / 100).toLocaleString('en-IN')}`;

/** The wrong way. Every line here looks reasonable, which is exactly the problem. */
async function naiveTransfer(pool: Pool, from: number, to: number, userId: number, amount: number, workMs: number): Promise<'ok' | 'rejected'> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT balance FROM accounts WHERE id = $1', [from]); // (1) read: NO LOCK
    const balance: number = rows[0].balance;
    if (balance < amount) {
      await c.query('ROLLBACK');
      return 'rejected'; // (2) check in application code
    }
    if (workMs) await sleep(workMs); // real services do work here: validation, a fraud call, logging...
    await c.query('UPDATE accounts SET balance = $1 WHERE id = $2', [balance - amount, from]); // (3) write a value computed from a STALE read
    await c.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to]);
    const t = await c.query(
      `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, initiated_by_user_id)
       VALUES ('PEER_TRANSFER', 'COMPLETED', $1, $2, $3, $4) RETURNING id`,
      [amount, from, to, userId],
    );
    await c.query(
      `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'D', $3), ($1, $4, 'C', $3)`,
      [t.rows[0].id, from, amount, to],
    );
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The OTHER correct approach: no explicit locks, SERIALIZABLE isolation, retry the whole transaction on 40001. */
async function serializableTransfer(pool: Pool, from: number, to: number, userId: number, amount: number, stats: { retries: number }): Promise<'ok' | 'rejected'> {
  for (let attempt = 0; attempt < 5000; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const { rows } = await c.query('SELECT balance FROM accounts WHERE id = $1', [from]);
      if (rows[0].balance < amount) {
        await c.query('ROLLBACK');
        return 'rejected';
      }
      await c.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, from]);
      await c.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to]);
      const t = await c.query(
        `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, initiated_by_user_id)
         VALUES ('PEER_TRANSFER', 'COMPLETED', $1, $2, $3, $4) RETURNING id`,
        [amount, from, to, userId],
      );
      await c.query(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'D', $3), ($1, $4, 'C', $3)`, [t.rows[0].id, from, amount, to]);
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if ((e as { code?: string }).code === '40001') {
        stats.retries++; // serialization failure: the database asks us to start over
        await sleep(Math.random() * 5 * Math.min(attempt + 1, 10));
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
  throw new Error('gave up after 5000 attempts');
}

async function audit(pool: Pool, wallet: number, dest: number) {
  const stored = (await pool.query('SELECT balance FROM accounts WHERE id = $1', [wallet])).rows[0].balance as number;
  const computed = (
    await pool.query(`SELECT COALESCE(SUM(CASE WHEN direction = 'C' THEN amount ELSE -amount END), 0) AS b FROM ledger_entries WHERE account_id = $1`, [wallet])
  ).rows[0].b as number;
  const r = await startReconciliation(pool, 'MANUAL');
  if (!r.started) throw new Error('lock busy');
  const summary = await r.done;
  // The job audits the WHOLE database (earlier runs left damage behind), so report only this run's two wallets.
  const issues = (
    await pool.query(
      `SELECT check_name, count(*)::int AS n FROM reconciliation_issues
        WHERE run_id = $1 AND subject_type = 'ACCOUNT' AND subject_id = ANY($2::bigint[]) GROUP BY 1 ORDER BY 1`,
      [summary.runId, [wallet, dest]],
    )
  ).rows;
  return { stored, computed, issues };
}

async function main() {
  const dbName = 'wallet_naive_lab';
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const pool = createPool(ADMIN.replace(/\/[^/]*$/, `/${dbName}`), 40);
  await migrate(pool);
  const api = await makeApi(pool, undefined, config);

  const lines: string[] = [];
  const out = (s = '') => {
    lines.push(s);
    console.log(s);
  };
  out('# Step 2: break it first (and compare with the locked version)');
  out();
  out('Setup for every run: one wallet with **Rs 500**, then **100 concurrent transfers of Rs 10** out of it. Correct answer: exactly 50 succeed, wallet ends at Rs 0, never negative.');
  out('Generated by `npm run lab:naive`; the numbers below are what actually happened.');
  out();
  out('| Implementation | Succeeded | Stored balance | Balance computed from ledger | Reconciliation issues | Wall time | Retries |');
  out('|---|---|---|---|---|---|---|');

  const rows: string[] = [];
  const fresh2 = async (amount: number) => ({ src: await api.fundedUser('S2', amount), dst: await api.fundedUser('D2', 0) });
  const fresh = async () => {
    const src = await api.fundedUser('Src', 50_000);
    const dst = await api.fundedUser('Dst', 0);
    return { src, dst };
  };
  for (const [label, workMs] of [['naive, no artificial delay', 0], ['naive, 5 ms of app work between check and write', 5]] as const) {
    const { src, dst } = await fresh();
    const t0 = performance.now();
    const res = await Promise.all(Array.from({ length: 100 }, () => naiveTransfer(pool, src.walletId, dst.walletId, src.userId, 1_000, workMs)));
    const ms = performance.now() - t0;
    const ok = res.filter((x) => x === 'ok').length;
    const a = await audit(pool, src.walletId, dst.walletId);
    rows.push(`| ${label} | **${ok}** / 100 | ${rs(a.stored)} | **${rs(a.computed)}** | ${a.issues.map((i) => `${i.check_name} x${i.n}`).join(', ') || 'none'} | ${ms.toFixed(0)} ms | n/a |`);
  }
  {
    const { src, dst } = await fresh();
    const t0 = performance.now();
    const res = await Promise.all(Array.from({ length: 100 }, () => api.post('/transfers', { from_wallet_id: src.walletId, to_wallet_id: dst.walletId, amount: 1_000 }, { user: src.userId })));
    const ms = performance.now() - t0;
    const ok = res.filter((x) => x.status === 201).length;
    const a = await audit(pool, src.walletId, dst.walletId);
    rows.push(`| **locked: READ COMMITTED + SELECT FOR UPDATE (the real code)** | **${ok}** / 100 | ${rs(a.stored)} | **${rs(a.computed)}** | ${a.issues.map((i) => `${i.check_name} x${i.n}`).join(', ') || 'none'} | ${ms.toFixed(0)} ms | 0 |`);
  }
  {
    const { src, dst } = await fresh();
    const stats = { retries: 0 };
    const t0 = performance.now();
    const res = await Promise.all(Array.from({ length: 100 }, () => serializableTransfer(pool, src.walletId, dst.walletId, src.userId, 1_000, stats)));
    const ms = performance.now() - t0;
    const ok = res.filter((x) => x === 'ok').length;
    const a = await audit(pool, src.walletId, dst.walletId);
    rows.push(`| **SERIALIZABLE, no locks, retry on 40001** | **${ok}** / 100 | ${rs(a.stored)} | **${rs(a.computed)}** | ${a.issues.map((i) => `${i.check_name} x${i.n}`).join(', ') || 'none'} | ${ms.toFixed(0)} ms | **${stats.retries}** |`);
  }
  rows.forEach((r) => out(r));
  out();
  out('The exact stored balance of the naive runs differs every time (it depends on thread timing; I saw Rs 460, 490 and 470 across runs). What did not change in any run: all 100 transfers "succeeded" and the ledger-computed balance was Rs -500.');
  out();
  out('## What went wrong in the naive version');
  out();
  out('1. It **reads** the balance with no lock, so 100 requests all see "Rs 500" at nearly the same moment.');
  out('2. Each one passes the `balance >= amount` check against that stale number.');
  out('3. Each then **writes** `balance = 500 - 10 = 490` (a value computed from its stale read), overwriting what the others wrote. That is a **lost update**: the stored balance barely moves.');
  out('4. But every request also inserted its ledger entries, so the *ledger* says far more than Rs 500 left the wallet. The computed balance is **negative**: money was created out of nothing, and the stored balance hides it.');
  out('5. The `CHECK (balance >= 0)` constraint did not save us: the naive code never writes a negative *stored* number. That is why the nightly reconciliation job (stored vs computed) exists, and why it caught this above.');
  out();
  out('**SERIALIZABLE is also correct** here (50 succeed, balance Rs 0, books clean) and, at this small scale on a local database, its wall time is in the same range as locking. The cost shows up elsewhere: **aborted attempts**. Every `40001` is a whole transaction thrown away and re-run, and every caller must implement that retry loop correctly. With locks the same requests simply wait their turn, with zero aborts. How the waste grows with contention (all requests succeed in this experiment, so only the number of writers changes):');
  out();
  out('| Concurrent writers on ONE wallet | Total attempts for that many requests | Retries (aborted attempts) | Retries per request | Wall time |');
  out('|---|---|---|---|---|');
  for (const n of [5, 10, 25, 50, 100, 200]) {
    const { src, dst } = await fresh2(n * 1_000);
    const st = { retries: 0 };
    const t0 = performance.now();
    await Promise.all(Array.from({ length: n }, () => serializableTransfer(pool, src.walletId, dst.walletId, src.userId, 1_000, st)));
    out(`| ${n} | ${n + st.retries} | ${st.retries} | ${(st.retries / n).toFixed(1)} | ${(performance.now() - t0).toFixed(0)} ms |`);
  }
  out();
  out('The locked version takes `SELECT ... FOR UPDATE` on the wallet row first, so the 100 transactions run the read-check-write sequence **one at a time**, each seeing the previous one\'s committed balance.');
  await writeFile(new URL('../docs/naive-stampede.md', import.meta.url), `${lines.join('\n')}\n`);

  await pool.end();
  const a2 = new pg.Client({ connectionString: ADMIN });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await a2.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
