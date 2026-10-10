import type { Client, Pool } from '../db';
import { isPgError } from '../db';

/**
 * Nightly reconciliation (Milestone 4).
 *
 *  - ONE run at a time: the run starts with
 *        SELECT ... FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE NOWAIT
 *    If another run (any process) holds that row, NOWAIT errors out immediately and
 *    we exit instead of queueing up.
 *  - ONE consistent view: all checks run in a single REPEATABLE READ transaction,
 *    i.e. one snapshot. Transfers committing while the job runs can't make check 2
 *    disagree with check 1.
 *  - REPORT, never FIX: the job only writes to reconciliation_runs/_issues.
 *    (Those writes use a different connection, so they survive even if the
 *    checking transaction fails, and are visible while the run is in progress.)
 */

export type Issue = {
  check: string;
  subjectType: 'LEDGER' | 'TRANSFER' | 'ACCOUNT' | 'ENTRY';
  subjectId: number | null;
  expected: string;
  actual: string;
};

export type RunSummary = {
  runId: number;
  status: 'CLEAN' | 'ISSUES_FOUND' | 'ERROR';
  checksRun: number;
  issuesFound: number;
  entriesScanned: number;
};

export const CHECKS = ['GLOBAL_BALANCE', 'TRANSFER_BALANCE', 'STORED_BALANCE', 'NO_OVERDRAFT', 'ORPHAN'] as const;
const CAP = 10_000; // never let a badly corrupted ledger produce millions of rows

// ---- the five checks, each one a SQL query --------------------------------

// 1. Everything balances: total debits == total credits. (Full scan; cheap enough nightly.)
export const SQL_GLOBAL = `
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0) AS debits,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0) AS credits,
         COUNT(*)                                                AS entries
    FROM ledger_entries`;

// 2. Every transfer balances. GROUP BY ... HAVING lists only the broken ones.
export const SQL_TRANSFER = `
  SELECT transfer_id,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0) AS debits,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0) AS credits
    FROM ledger_entries
   GROUP BY transfer_id
  HAVING COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0)
      <> COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0)
   ORDER BY transfer_id
   LIMIT ${CAP + 1}`;

// 3. Stored balance == balance computed from entries (credits - debits).
//    Aggregate entries once (hash aggregate), then join to the small accounts table.
export const SQL_STORED = `
  WITH computed AS (
    SELECT account_id,
           SUM(CASE WHEN direction = 'C' THEN amount ELSE -amount END) AS balance
      FROM ledger_entries
     GROUP BY account_id
  )
  SELECT a.id, a.balance AS stored, COALESCE(c.balance, 0) AS computed
    FROM accounts a
    LEFT JOIN computed c ON c.account_id = a.id
   WHERE a.balance <> COALESCE(c.balance, 0)
   ORDER BY a.id
   LIMIT ${CAP + 1}`;

// 4. No overdrafts: no USER wallet's computed balance is below zero.
export const SQL_OVERDRAFT = `
  SELECT a.id,
         COALESCE(SUM(CASE WHEN e.direction = 'C' THEN e.amount ELSE -e.amount END), 0) AS computed
    FROM accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.id
   WHERE a.kind = 'USER_WALLET'
   GROUP BY a.id
  HAVING COALESCE(SUM(CASE WHEN e.direction = 'C' THEN e.amount ELSE -e.amount END), 0) < 0
   ORDER BY a.id
   LIMIT ${CAP + 1}`;

// 5a. A transfer that moved money must have entries (HELD / REJECTED ones legitimately have none).
export const SQL_NO_ENTRIES = `
  SELECT t.id
    FROM transfers t
   WHERE t.status IN ('COMPLETED', 'REVERSED')
     AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transfer_id = t.id)
   ORDER BY t.id
   LIMIT ${CAP + 1}`;
// 5b. ...and one that did NOT move money must not have any.
export const SQL_UNEXPECTED_ENTRIES = `
  SELECT t.id, COUNT(*) AS entries
    FROM transfers t
    JOIN ledger_entries e ON e.transfer_id = t.id
   WHERE t.status IN ('HELD', 'REJECTED')
   GROUP BY t.id
   ORDER BY t.id
   LIMIT ${CAP + 1}`;
// 5c. Every entry has a transfer (the FK should make this impossible - we verify anyway).
export const SQL_ORPHAN_ENTRIES = `
  SELECT e.id
    FROM ledger_entries e
    LEFT JOIN transfers t ON t.id = e.transfer_id
   WHERE t.id IS NULL
   ORDER BY e.id
   LIMIT ${CAP + 1}`;

export async function runChecks(db: Client): Promise<{ issues: Issue[]; entriesScanned: number }> {
  const issues: Issue[] = [];
  const cap = <T>(rows: T[], check: string): T[] => {
    if (rows.length > CAP) {
      issues.push({ check, subjectType: 'LEDGER', subjectId: null, expected: `at most ${CAP} issues`, actual: 'truncated: more issues exist' });
      return rows.slice(0, CAP);
    }
    return rows;
  };

  const g = (await db.query<{ debits: number; credits: number; entries: number }>(SQL_GLOBAL)).rows[0];
  if (g.debits !== g.credits) {
    issues.push({ check: 'GLOBAL_BALANCE', subjectType: 'LEDGER', subjectId: null, expected: `credits = ${g.debits}`, actual: `credits = ${g.credits}` });
  }

  for (const r of cap((await db.query<{ transfer_id: number; debits: number; credits: number }>(SQL_TRANSFER)).rows, 'TRANSFER_BALANCE')) {
    issues.push({ check: 'TRANSFER_BALANCE', subjectType: 'TRANSFER', subjectId: r.transfer_id, expected: `credits = ${r.debits}`, actual: `credits = ${r.credits}` });
  }

  for (const r of cap((await db.query<{ id: number; stored: number; computed: number }>(SQL_STORED)).rows, 'STORED_BALANCE')) {
    issues.push({ check: 'STORED_BALANCE', subjectType: 'ACCOUNT', subjectId: r.id, expected: `balance = ${r.computed}`, actual: `balance = ${r.stored}` });
  }

  for (const r of cap((await db.query<{ id: number; computed: number }>(SQL_OVERDRAFT)).rows, 'NO_OVERDRAFT')) {
    issues.push({ check: 'NO_OVERDRAFT', subjectType: 'ACCOUNT', subjectId: r.id, expected: 'computed balance >= 0', actual: `computed balance = ${r.computed}` });
  }

  for (const r of cap((await db.query<{ id: number }>(SQL_NO_ENTRIES)).rows, 'ORPHAN')) {
    issues.push({ check: 'ORPHAN', subjectType: 'TRANSFER', subjectId: r.id, expected: 'at least 2 ledger entries', actual: '0 ledger entries' });
  }
  for (const r of cap((await db.query<{ id: number; entries: number }>(SQL_UNEXPECTED_ENTRIES)).rows, 'ORPHAN')) {
    issues.push({ check: 'ORPHAN', subjectType: 'TRANSFER', subjectId: r.id, expected: '0 ledger entries (transfer moved no money)', actual: `${r.entries} ledger entries` });
  }
  for (const r of cap((await db.query<{ id: number }>(SQL_ORPHAN_ENTRIES)).rows, 'ORPHAN')) {
    issues.push({ check: 'ORPHAN', subjectType: 'ENTRY', subjectId: r.id, expected: 'entry points at an existing transfer', actual: 'transfer missing' });
  }

  return { issues, entriesScanned: g.entries };
}

export type StartResult =
  | { started: false; reason: 'ALREADY_RUNNING' }
  | { started: true; runId: number; done: Promise<RunSummary> };

/**
 * Takes the job lock, creates the run row and returns immediately; the checks
 * continue in the background and `done` resolves when the report is saved.
 */
/**
 * Open the job's snapshot and take the job lock. Returns false if another run holds it.
 * BEGIN ... REPEATABLE READ + the FOR UPDATE NOWAIT below means: from this statement on,
 * every query on this connection sees the database exactly as it was at this instant.
 */
export async function beginSnapshotAndLock(client: Client): Promise<boolean> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    // This first statement also fixes the snapshot every later check will read from.
    await client.query(`SELECT job_name FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE NOWAIT`);
    return true;
  } catch (e) {
    if (isPgError(e, '55P03')) return false; // lock_not_available: someone else is running
    throw e;
  }
}

export async function startReconciliation(pool: Pool, trigger: 'CRON' | 'MANUAL'): Promise<StartResult> {
  const checker = await pool.connect();
  let handedOff = false;
  try {
    if (!(await beginSnapshotAndLock(checker))) return { started: false, reason: 'ALREADY_RUNNING' };

    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO reconciliation_runs (trigger) VALUES ($1) RETURNING id',
      [trigger],
    );
    const runId = rows[0].id;

    const done = (async (): Promise<RunSummary> => {
      try {
        const { issues, entriesScanned } = await runChecks(checker);
        await saveIssues(pool, runId, issues);
        const status = issues.length === 0 ? 'CLEAN' : 'ISSUES_FOUND';
        await pool.query(
          `UPDATE reconciliation_runs
              SET status = $2, finished_at = now(), checks_run = $3, issues_found = $4, ledger_entries_scanned = $5
            WHERE id = $1`,
          [runId, status, CHECKS.length, issues.length, entriesScanned],
        );
        return { runId, status, checksRun: CHECKS.length, issuesFound: issues.length, entriesScanned };
      } catch (e) {
        await pool
          .query(`UPDATE reconciliation_runs SET status = 'ERROR', finished_at = now(), error = $2 WHERE id = $1`, [
            runId,
            (e as Error).message,
          ])
          .catch(() => {});
        return { runId, status: 'ERROR', checksRun: 0, issuesFound: 0, entriesScanned: 0 };
      } finally {
        await checker.query('ROLLBACK').catch(() => {}); // read-only snapshot: nothing to commit; releases the lock
        checker.release();
      }
    })();
    handedOff = true;
    return { started: true, runId, done };
  } finally {
    if (!handedOff) {
      await checker.query('ROLLBACK').catch(() => {});
      checker.release();
    }
  }
}

async function saveIssues(pool: Pool, runId: number, issues: Issue[]): Promise<void> {
  const BATCH = 2000;
  for (let i = 0; i < issues.length; i += BATCH) {
    const part = issues.slice(i, i + BATCH);
    await pool.query(
      `INSERT INTO reconciliation_issues (run_id, check_name, subject_type, subject_id, expected, actual)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[])`,
      [
        runId,
        part.map((x) => x.check),
        part.map((x) => x.subjectType),
        part.map((x) => x.subjectId),
        part.map((x) => x.expected),
        part.map((x) => x.actual),
      ],
    );
  }
}

export async function getRun(pool: Pool, id: number) {
  const run = (await pool.query('SELECT * FROM reconciliation_runs WHERE id = $1', [id])).rows[0];
  if (!run) return null;
  const issues = (
    await pool.query(
      `SELECT check_name, subject_type, subject_id, expected, actual
         FROM reconciliation_issues WHERE run_id = $1 ORDER BY id LIMIT 1000`,
      [id],
    )
  ).rows;
  return { ...run, issues };
}
