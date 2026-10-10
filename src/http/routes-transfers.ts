import { createTransfer, reverseTransfer, type NewTransfer, type TransferOutcome } from '../ledger/transfers';
import { errors } from '../errors';
import { authenticate, idempotentPost, type Ctx } from './context';
import { presentEntry, presentTransfer } from './present';
import { asObject, optString, pathId, reqAmount, reqId } from './validate';

function outcomeBody(o: TransferOutcome) {
  return {
    ...presentTransfer(o.transfer),
    entries: o.entries.map(presentEntry),
    flags: o.fired.map((f) => ({ rule: f.code, action: f.action, detail: f.detail })),
  };
}

export function registerTransferRoutes(ctx: Ctx): void {
  const create = (path: string, build: (b: Record<string, unknown>, userId: number) => NewTransfer) =>
    idempotentPost(ctx, path, {
      auth: 'user',
      handler: async (client, { req, actor }) => {
        const userId = (actor as { id: number }).id;
        const outcome = await createTransfer(client, build(asObject(req.body), userId));
        // 201 = money moved. 202 = accepted but HELD for review; no money moved.
        return { status: outcome.held ? 202 : 201, body: outcomeBody(outcome) };
      },
    });

  // POST /transfers/topup   cash-in account -> wallet            201 | 409 | 422
  create('/transfers/topup', (b, userId) => ({
    type: 'TOPUP',
    userId,
    walletId: reqId(b.wallet_id, 'wallet_id'),
    amount: reqAmount(b.amount),
    note: optString(b.note, 'note', 280),
  }));

  // POST /transfers          wallet -> wallet                    201 | 202 (held) | 409 | 422
  create('/transfers', (b, userId) => ({
    type: 'PEER_TRANSFER',
    userId,
    fromWalletId: reqId(b.from_wallet_id, 'from_wallet_id'),
    toWalletId: reqId(b.to_wallet_id, 'to_wallet_id'),
    amount: reqAmount(b.amount),
    note: optString(b.note, 'note', 280),
  }));

  // POST /transfers/withdraw wallet -> cash-out account          201 | 202 (held) | 422
  create('/transfers/withdraw', (b, userId) => ({
    type: 'WITHDRAWAL',
    userId,
    walletId: reqId(b.wallet_id, 'wallet_id'),
    amount: reqAmount(b.amount),
    fee: ctx.config.withdrawalFeePaise,
    note: optString(b.note, 'note', 280),
  }));

  // POST /transfers/:id/reverse   a NEW transfer pointing at the original   201 | 409
  idempotentPost(ctx, '/transfers/:id/reverse', {
    auth: 'user',
    handler: async (client, { req, actor }) => {
      const id = pathId((req.params as { id: string }).id, 'transfer id');
      const reason = optString(asObject(req.body).reason, 'reason', 200) ?? undefined;
      const r = await reverseTransfer(client, id, actor, reason);
      return {
        status: 201,
        body: { ...presentTransfer(r.transfer), entries: r.entries.map(presentEntry) },
      };
    },
  });

  // GET /transfers/:id -> the transfer, its entries, its status history
  ctx.app.get('/transfers/:id', async (req) => {
    const actor = await authenticate(ctx, req, 'user');
    const id = pathId((req.params as { id: string }).id, 'transfer id');
    const userId = (actor as { id: number }).id;
    const { rows } = await ctx.pool.query(
      `SELECT t.* FROM transfers t
        WHERE t.id = $1
          AND (t.initiated_by_user_id = $2
               OR t.source_account_id      IN (SELECT id FROM accounts WHERE user_id = $2)
               OR t.destination_account_id IN (SELECT id FROM accounts WHERE user_id = $2))`,
      [id, userId],
    );
    if (!rows[0]) throw errors.notFound('transfer');
    return transferDetail(ctx, rows[0]);
  });
}

export async function transferDetail(ctx: Ctx, t: Parameters<typeof presentTransfer>[0]) {
  const entries = (await ctx.pool.query('SELECT * FROM ledger_entries WHERE transfer_id = $1 ORDER BY id', [t.id])).rows;
  const history = (
    await ctx.pool.query(
      `SELECT from_status, to_status, changed_by, reason, changed_at
         FROM transfer_status_history WHERE transfer_id = $1 ORDER BY id`,
      [t.id],
    )
  ).rows;
  return { ...presentTransfer(t), entries: entries.map(presentEntry), status_history: history };
}
