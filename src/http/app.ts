import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Pool } from '../db';
import { AppError } from '../errors';
import type { LlmClient } from '../llm/client';
import type { Ctx } from './context';
import { registerAdminRoutes } from './routes-admin';
import { registerTransferRoutes } from './routes-transfers';
import { registerUserRoutes } from './routes-users';
import { registerWalletRoutes } from './routes-wallets';

export async function buildApp(deps: { pool: Pool; llm: LlmClient; config: Config; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });

  // JSON parser that treats an empty body as {} (e.g. POST /transfers/12/reverse with no body).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON'), undefined);
    }
  });

  // ONE error shape everywhere: {"code", "message", "request_id"}
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, request_id: req.id });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ code: 'BAD_REQUEST', message: e.message ?? 'Bad request', request_id: req.id });
    }
    req.log.error(err);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Something went wrong. Please retry.', request_id: req.id });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ code: 'NOT_FOUND', message: `No route ${req.method} ${req.url.split('?')[0]}`, request_id: req.id }),
  );

  const ctx: Ctx = { app, pool: deps.pool, llm: deps.llm, config: deps.config };
  app.get('/health', async () => ({ ok: true }));
  registerUserRoutes(ctx);
  registerWalletRoutes(ctx);
  registerTransferRoutes(ctx);
  registerAdminRoutes(ctx);
  await app.ready();
  return app;
}
