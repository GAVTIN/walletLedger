import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Client, Pool } from '../db';
import { AppError } from '../errors';
import type { LlmClient } from '../llm/client';
import type { Actor } from '../types';
import { parseIdempotencyKey, runIdempotent, type Handled } from './idempotency';

export type Ctx = { app: FastifyInstance; pool: Pool; llm: LlmClient; config: Config };
export type AuthMode = 'none' | 'user' | 'admin';

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Stand-in for real authentication, kept deliberately small:
 *   users  send   X-User-Id: <id>
 *   admins send   X-Admin-Token: <ADMIN_TOKEN>
 * In production this would be a signed token (JWT/session); everything
 * downstream only ever sees the resulting Actor.
 */
export async function authenticate(ctx: Ctx, req: FastifyRequest, mode: AuthMode): Promise<Actor> {
  if (mode === 'none') return { kind: 'anonymous' };
  if (mode === 'admin') {
    const t = req.headers['x-admin-token'];
    if (typeof t !== 'string' || !timingSafeEqual(sha(t), sha(ctx.config.adminToken))) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Missing or invalid X-Admin-Token');
    }
    return { kind: 'admin' };
  }
  const h = req.headers['x-user-id'];
  if (typeof h !== 'string' || !/^\d{1,15}$/.test(h)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Missing or invalid X-User-Id header');
  }
  const { rowCount } = await ctx.pool.query('SELECT 1 FROM users WHERE id = $1', [Number(h)]);
  if (!rowCount) throw new AppError(401, 'UNAUTHENTICATED', 'Unknown user');
  return { kind: 'user', id: Number(h) };
}

export type PostHandlerArgs<C> = { req: FastifyRequest; actor: Actor; ctx: C };

/** Register a POST route. Every POST goes through the idempotency wrapper. */
export function idempotentPost<C = undefined>(
  ctx: Ctx,
  path: string,
  opts: {
    auth: AuthMode;
    pre?: (req: FastifyRequest, actor: Actor) => Promise<C>;
    handler: (client: Client, a: PostHandlerArgs<C>) => Promise<Handled>;
  },
): void {
  ctx.app.post(path, async (req, reply) => {
    const actor = await authenticate(ctx, req, opts.auth);
    const key = parseIdempotencyKey(req.headers['idempotency-key']);
    const sent = await runIdempotent<C>(ctx.pool, {
      actor,
      key,
      method: 'POST',
      path: req.url.split('?')[0],
      body: req.body,
      requestId: req.id,
      pre: opts.pre ? () => opts.pre!(req, actor) : undefined,
      handler: (client, c) => opts.handler(client, { req, actor, ctx: c }),
    });
    reply
      .code(sent.status)
      .header('content-type', 'application/json; charset=utf-8')
      .header('idempotent-replay', String(sent.replay))
      .send(sent.body);
  });
}
