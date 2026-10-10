import { createPool } from '../db';
import { migrate } from './migrate';

const pool = createPool(undefined, 2);
try {
  const applied = await migrate(pool, console.log);
  console.log(applied.length ? `done (${applied.length} applied)` : 'schema already up to date');
} finally {
  await pool.end();
}
