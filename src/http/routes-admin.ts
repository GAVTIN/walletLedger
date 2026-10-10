import { errors } from '../errors';
import { markFlagsReviewed, rejectHeld, releaseHeld, reverseTransfer } from '../ledger/transfers';
import { getRun, startReconciliation } from '../recon/reconcile';
import { authenticate, idempotentPost, type Ctx } from './context';
import { presentEntry, presentTransfer } from './present';
import { asObject, optString, pathId, queryInt } from './validate';

export function registerAdminRoutes(ctx: Ctx): void {
  // POST /admin/reconciliation/run -> 202. The checks run in the background.
  idempotentPost(ctx, '/admin/reconciliation/run', {
    auth: 'admin',
    handler: async () => {
      const r = await startReconciliation(ctx.pool, 'MANUAL');
      if (!r.started) {
        return { status: 202, body: { started: false, reason: 'another reconciliation run is already in progress' } };
      }
      return { status: 202, body: { started: true, run_id: r.runId } };
    },
  });

  // GET /admin/reconciliation/runs/:id -> run report and issues
  ctx.app.get('/admin/reconciliation/runs/:id', async (req) => {
    await authenticate(ctx, req, 'admin');
    const run = await getRun(ctx.pool, pathId((req.params as { id: string }).id, 'run id'));
    if (!run) throw errors.notFound('reconciliation run');
    return run;
  });

  // GET /admin/risk/queue -> held transfers + flagged transfers nobody has reviewed yet
  ctx.app.get('/admin/risk/queue', async (req) => {
    await authenticate(ctx, req, 'admin');
    const limit = queryInt((req.query as Record<string, string | undefined>).limit, 'limit', 50, 1, 200);
    const { rows } = await ctx.pool.query(
      `SELECT t.*,
              (SELECT json_agg(json_build_object(
                         'rule', f.rule_code, 'action_taken', f.action_taken, 'detail', f.detail,
                         'llm_label', f.llm_label, 'llm_explanation', f.llm_explanation)
                       ORDER BY f.id)
                 FROM risk_flags f WHERE f.transfer_id = t.id) AS flags
         FROM transfers t
        WHERE t.id IN (SELECT id FROM transfers WHERE status = 'HELD'
                       UNION
                       SELECT transfer_id FROM risk_flags WHERE reviewed_at IS NULL)
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $1`,
      [limit],
    );
    return { items: rows.map((r) => ({ ...presentTransfer(r), flags: r.flags ?? [] })) };
  });

  // POST /admin/risk/:transfer_id/decision  { decision: "release" | "reverse", reason? }
  //   HELD      + release -> the money moves now, status COMPLETED
  //   HELD      + reverse -> REJECTED (it never moved, so nothing to undo)
  //   COMPLETED + release -> flags marked reviewed
  //   COMPLETED + reverse -> a real REVERSAL transfer
  idempotentPost(ctx, '/admin/risk/:transfer_id/decision', {
    auth: 'admin',
    handler: async (client, { req, actor }) => {
      const id = pathId((req.params as { transfer_id: string }).transfer_id, 'transfer id');
      const b = asObject(req.body);
      if (b.decision !== 'release' && b.decision !== 'reverse') {
        throw errors.validation('decision must be "release" or "reverse"');
      }
      const reason = optString(b.reason, 'reason', 200) ?? undefined;

      const { rows } = await client.query<{ status: string }>('SELECT status FROM transfers WHERE id = $1', [id]);
      if (!rows[0]) throw errors.notFound('transfer');

      if (rows[0].status === 'HELD') {
        const r = b.decision === 'release' ? await releaseHeld(client, id, actor, reason) : await rejectHeld(client, id, actor, reason);
        return {
          status: 200,
          body: { decision: b.decision, transfer: presentTransfer(r.transfer), entries: r.entries.map(presentEntry) },
        };
      }
      if (rows[0].status === 'COMPLETED') {
        if (b.decision === 'release') {
          await markFlagsReviewed(client, id, actor);
          return { status: 200, body: { decision: 'release', transfer_id: id, note: 'flags marked as reviewed' } };
        }
        const r = await reverseTransfer(client, id, actor, reason);
        await markFlagsReviewed(client, id, actor);
        return {
          status: 200,
          body: { decision: 'reverse', reversal: presentTransfer(r.transfer), entries: r.entries.map(presentEntry) },
        };
      }
      throw errors.conflict('NOT_DECIDABLE', `Transfer is ${rows[0].status}; nothing to decide`);
    },
  });
}
