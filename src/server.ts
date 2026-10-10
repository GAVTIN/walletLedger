import { config } from './config';
import { createPool } from './db';
import { migrate } from './db/migrate';
import { buildApp } from './http/app';
import { createLlm } from './llm';

const pool = createPool();
await migrate(pool, (m) => console.log(`[migrate] ${m}`));
const app = await buildApp({ pool, llm: createLlm(config), config, logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });

const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
