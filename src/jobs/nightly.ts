import type { Config } from '../config';
import type { Pool } from '../db';
import type { LlmClient } from '../llm/client';
import { startReconciliation } from '../recon/reconcile';
import { explainPendingFlags } from '../risk/explain';

/**
 * The nightly job, in order:
 *   1. reconciliation (takes the job_locks row; exits quietly if another run holds it)
 *   2. LLM explanations for today's flagged transfers (milestone 5, part B)
 *   3. delete idempotency keys older than 24h (milestone 3, optional)
 * Steps 2 and 3 are idempotent, so a crash halfway is fixed by simply running again.
 */
export async function runNightly(pool: Pool, llm: LlmClient, cfg: Pick<Config, 'llmMaxExplainPerRun'>, log: (m: string) => void = console.log) {
  const rec = await startReconciliation(pool, 'CRON');
  if (!rec.started) {
    log('reconciliation already running elsewhere - skipping this run');
    return { reconciliation: null, explained: null, keysDeleted: 0 };
  }
  const summary = await rec.done;
  log(`reconciliation #${summary.runId}: ${summary.status}, ${summary.issuesFound} issue(s), ${summary.entriesScanned} entries scanned`);

  const explained = await explainPendingFlags(pool, llm, { max: cfg.llmMaxExplainPerRun, sinceHours: 24 });
  log(`flag explanations: ${explained.explained} saved, ${explained.failed} failed`);

  const del = await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  log(`idempotency keys purged: ${del.rowCount}`);
  return { reconciliation: summary, explained, keysDeleted: del.rowCount ?? 0 };
}
