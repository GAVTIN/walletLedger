import cron from 'node-cron';
import { config } from '../config';
import { createPool } from '../db';
import { migrate } from '../db/migrate';
import { createLlm } from '../llm';
import { runNightly } from './nightly';

const pool = createPool(undefined, 5);
await migrate(pool, (m) => console.log(`[migrate] ${m}`));
const llm = createLlm(config);

const run = () =>
  runNightly(pool, llm, config).catch((e) => console.error('[nightly] failed:', (e as Error).message));

if (process.argv.includes('--once')) {
  await run();
  await pool.end();
} else {
  cron.schedule(config.reconCron, run, { timezone: config.cronTimezone });
  console.log(`[worker] nightly job scheduled: "${config.reconCron}" (${config.cronTimezone}). Ctrl-C to stop.`);
  const stop = async () => {
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
