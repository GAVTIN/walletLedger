/**
 * Seed script: 1,000 users, 2,000 wallets, 100,000 transfers (200,000 ledger entries).
 *
 *   npm run seed                              # defaults
 *   npm run seed -- --users 200 --transfers 20000
 *
 * Idempotent-ish: running it twice simply adds another batch. Uses the same bulk
 * generator as the tests (src/seed/generate.ts); every row still passes the schema's
 * constraints and triggers.
 */
import { createPool } from '../src/db';
import { migrate } from '../src/db/migrate';
import { seedData } from '../src/seed/generate';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};

const pool = createPool(undefined, 5);
try {
  await migrate(pool, (m) => console.log(`[migrate] ${m}`));
  const t0 = Date.now();
  const r = await seedData(pool, {
    users: arg('users', 1000),
    transfers: arg('transfers', 100_000),
    seed: arg('seed', 42),
    days: arg('days', 90),
    log: (m) => console.log(`[seed] ${m}`),
  });
  console.log(`[seed] done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${r.users} users, ${r.wallets} wallets, ${r.transfers} transfers, ${r.entries} ledger entries`);
} finally {
  await pool.end();
}
