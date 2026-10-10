import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Pool } from '../../src/db';
import { ADMIN_URL, TEMPLATE } from './global-setup';

export type TestDb = { pool: Pool; url: string; drop: () => Promise<void> };

export async function createTestDb(poolMax = 20): Promise<TestDb> {
  const name = `wallet_t_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const pool = createPool(url, poolMax);
  return {
    pool,
    url,
    drop: async () => {
      // pool.end() can return before the server has closed every socket, and DROP ... FORCE
      // then kills the stragglers. That is expected teardown noise, so mute it here only.
      pool.removeAllListeners('error');
      pool.on('error', () => {});
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
