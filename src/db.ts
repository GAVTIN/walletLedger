import pg from 'pg';
import { config } from './config';

// BIGINT (int8, oid 20) and NUMERIC (oid 1700, what SUM() returns) come back as
// strings by default so nothing is silently rounded. All of our amounts are
// capped well below 2^53, so converting to number is lossless - and we assert it.
function toSafeNumber(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`integer ${v} is outside JS safe range`);
  return n;
}
pg.types.setTypeParser(20, toSafeNumber);
pg.types.setTypeParser(1700, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`numeric ${v} is not a safe integer`);
  return n;
});

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(url = config.databaseUrl, max = config.poolMax): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max });
  // An idle client erroring must not crash the process.
  pool.on('error', (e) => console.error('pg pool error', e.message));
  return pool;
}

/**
 * Run fn inside ONE transaction. The money path calls this (or the idempotency
 * wrapper, which does the same) so BEGIN / COMMIT / ROLLBACK are always visible.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: Client) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

export const isPgError = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === code;
