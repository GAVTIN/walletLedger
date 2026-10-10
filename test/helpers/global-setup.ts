import pg from 'pg';
import { createPool } from '../../src/db';
import { migrate } from '../../src/db/migrate';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
export const TEMPLATE = 'wallet_test_template';

/** Build ONE migrated template database; every test file clones it (fast, isolated). */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEMPLATE}`);
  const pool = createPool(url, 2);
  await migrate(pool);
  await pool.end();
}
