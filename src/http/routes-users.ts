import { isPgError } from '../db';
import { AppError, errors } from '../errors';
import { parseQuestion, runIntent, UNSUPPORTED_MESSAGE } from '../qa/ask';
import { authenticate, idempotentPost, type Ctx } from './context';
import { asObject, optString, pathId, reqEmail, reqPhone, reqString } from './validate';

export function registerUserRoutes(ctx: Ctx): void {
  // POST /users -> 201
  idempotentPost(ctx, '/users', {
    auth: 'none',
    handler: async (client, { req }) => {
      const b = asObject(req.body);
      const name = reqString(b.name, 'name', 100);
      const email = reqEmail(b.email);
      const phone = reqPhone(b.phone);
      try {
        const { rows } = await client.query(
          `INSERT INTO users (name, email, phone) VALUES ($1, $2, $3)
           RETURNING id, name, email, phone, kyc_status, created_at`,
          [name, email, phone],
        );
        return { status: 201, body: rows[0] };
      } catch (e) {
        if (isPgError(e, '23505')) throw errors.conflict('USER_EXISTS', 'A user with this email or phone already exists');
        throw e;
      }
    },
  });

  // POST /users/:id/wallets -> 201
  idempotentPost(ctx, '/users/:id/wallets', {
    auth: 'user',
    handler: async (client, { req, actor }) => {
      const userId = pathId((req.params as { id: string }).id, 'user id');
      if (actor.kind !== 'user' || actor.id !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only open wallets for yourself');
      const b = asObject(req.body);
      const name = optString(b.name, 'name', 30) ?? 'main';
      try {
        const { rows } = await client.query(
          `INSERT INTO accounts (kind, user_id, name) VALUES ('USER_WALLET', $1, $2)
           RETURNING id, user_id, name, currency, balance, created_at`,
          [userId, name],
        );
        return { status: 201, body: rows[0] };
      } catch (e) {
        if (isPgError(e, '23505')) throw errors.conflict('WALLET_EXISTS', `You already have a wallet named "${name}"`);
        throw e;
      }
    },
  });

  // POST /users/:id/statement/ask -> 200
  // The LLM call happens in `pre`, BEFORE the transaction opens, so no DB
  // connection or lock is held while we wait on the network.
  idempotentPost(ctx, '/users/:id/statement/ask', {
    auth: 'user',
    pre: async (req, actor) => {
      const userId = pathId((req.params as { id: string }).id, 'user id');
      if (actor.kind !== 'user' || actor.id !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only ask about your own statement');
      const question = reqString(asObject(req.body).question, 'question', 500);
      const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10); // IST calendar date
      return { userId, intent: await parseQuestion(ctx.llm, question, today) };
    },
    handler: async (client, { ctx: pre }) => {
      if (!pre.intent) {
        return { status: 200, body: { answered: false, answer: UNSUPPORTED_MESSAGE } };
      }
      return { status: 200, body: await runIntent(client, pre.userId, pre.intent) };
    },
  });

  // keep `authenticate` import used for GET routes registered elsewhere
  void authenticate;
}
