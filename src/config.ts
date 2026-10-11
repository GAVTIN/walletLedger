import './env';
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/wallet',
  port: Number(process.env.PORT ?? 3000),
  poolMax: Number(process.env.PG_POOL_MAX ?? 20),
  // Stand-in for real auth: admin endpoints require this header value.
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  // Flat withdrawal fee in paise (0 = no fee). When > 0 a withdrawal has THREE
  // ledger entries: wallet debit, cash-out credit, fee-revenue credit.
  withdrawalFeePaise: Number(process.env.WITHDRAWAL_FEE_PAISE ?? 0),
  // Largest single transfer we accept. Keeps every amount far inside JS's
  // safe-integer range (2^53 paise ~ Rs 9e13), so BIGINT -> number is lossless.
  maxAmountPaise: 100_000_000_000, // 1e11 paise = Rs 100 crore
  reconCron: process.env.RECON_CRON ?? '0 2 * * *',
  cronTimezone: process.env.CRON_TZ ?? 'Asia/Kolkata',
  llmProvider: (process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock')) as
    | 'mock'
    | 'anthropic',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? 'claude-sonnet-5-5',
  llmMaxExplainPerRun: Number(process.env.LLM_MAX_EXPLAIN_PER_RUN ?? 500),
};

export type Config = typeof config;
