import { createHash } from 'node:crypto';
import type { Client, Pool } from '../db';
import { AppError } from '../errors';
import type { Actor } from '../types';

/**
 * Idempotency keys (Milestone 3).
 *
 * Flow for every POST:
 *   BEGIN
 *   INSERT the key row first            <- the unique index lets exactly ONE
 *                                          concurrent request through
 *     conflict?  -> ROLLBACK, look up the stored row and respond:
 *                     same hash + COMPLETED  -> replay saved status+body, byte for byte
 *                     different hash         -> 422 IDEMPOTENCY_KEY_REUSED
 *                     still IN_PROGRESS      -> 409 IDEMPOTENCY_KEY_IN_PROGRESS
 *   run the business logic (inside a SAVEPOINT)
 *   save the response on the key row
 *   COMMIT                              <- key + money commit together or not at all
 *
 * Why two identical requests at the same instant are safe: the second INSERT
 * blocks on the first one's uncommitted index entry. When the first commits, the
 * second sees a conflict and replays the stored response; if the first rolls
 * back, the second's insert succeeds and it does the work itself.
 *
 * Business errors (4xx) are saved too, so a retry returns the same error. A
 * 5xx/unexpected failure rolls EVERYTHING back (including the key) so the client
 * can safely retry and actually get the work done.
 */

export type Handled = { status: number; body: unknown };
export type Sent = { status: number; body: string; replay: boolean };

/** JSON with sorted keys, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${path}\n${stableStringify(body ?? {})}`).digest('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || !UUID_RE.test(header)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Every POST needs an Idempotency-Key header containing a UUID');
  }
  return header.toLowerCase();
}

type StoredKey = { request_hash: string; status: string; response_code: number | null; response_body: string | null };

function respondToExisting(existing: StoredKey, hash: string): Sent {
  if (existing.request_hash !== hash) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body',
    );
  }
  if (existing.status === 'COMPLETED') {
    return { status: existing.response_code!, body: existing.response_body!, replay: true };
  }
  throw new AppError(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', 'A request with this key is still being processed');
}

async function lookup(db: Pool | Client, userId: number | null, key: string): Promise<StoredKey | undefined> {
  const { rows } = await db.query<StoredKey>(
    `SELECT request_hash, status, response_code, response_body
       FROM idempotency_keys
      WHERE COALESCE(user_id, 0) = COALESCE($1::bigint, 0) AND key = $2`,
    [userId, key],
  );
  return rows[0];
}

export async function runIdempotent<Ctx = undefined>(
  pool: Pool,
  args: {
    actor: Actor;
    key: string;
    method: string;
    path: string;
    body: unknown;
    requestId: string;
    /** Slow work that must NOT hold a transaction open (e.g. an LLM call). Runs only if the key is new. */
    pre?: () => Promise<Ctx>;
    handler: (client: Client, ctx: Ctx) => Promise<Handled>;
  },
): Promise<Sent> {
  const userId = args.actor.kind === 'user' ? args.actor.id : null;
  const hash = hashRequest(args.method, args.path, args.body);

  // Fast path: a finished request is replayed without opening a transaction.
  const seen = await lookup(pool, userId, args.key);
  if (seen) return respondToExisting(seen, hash);

  const ctx = (args.pre ? await args.pre() : undefined) as Ctx;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- insert the key FIRST ------------------------------------------------
    const ins = await client.query<{ id: number }>(
      `INSERT INTO idempotency_keys (user_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT ((COALESCE(user_id, 0)), key) DO NOTHING
       RETURNING id`,
      [userId, args.key, hash],
    );
    if (ins.rowCount === 0) {
      // Someone else owns this key (and has committed, or we'd have waited).
      await client.query('ROLLBACK');
      const existing = await lookup(client, userId, args.key);
      if (existing) return respondToExisting(existing, hash);
      // The row vanished (24h cleanup raced us): extraordinarily rare - ask for a retry.
      throw new AppError(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', 'Please retry this request');
    }
    const keyRowId = ins.rows[0].id;

    // ---- run the business logic inside a savepoint -----------------------------
    let result: Handled;
    await client.query('SAVEPOINT handler');
    try {
      result = await args.handler(client, ctx);
      await client.query('RELEASE SAVEPOINT handler');
    } catch (e) {
      if (e instanceof AppError && e.status < 500) {
        // Undo the business writes, keep the key row, and remember the error.
        await client.query('ROLLBACK TO SAVEPOINT handler');
        result = {
          status: e.status,
          body: { code: e.code, message: e.message, request_id: args.requestId },
        };
      } else {
        throw e;
      }
    }

    const bodyText = JSON.stringify(result.body);
    await client.query(
      `UPDATE idempotency_keys
          SET status = 'COMPLETED', response_code = $2, response_body = $3, completed_at = now()
        WHERE id = $1`,
      [keyRowId, result.status, bodyText],
    );
    await client.query('COMMIT');
    return { status: result.status, body: bodyText, replay: false };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}
