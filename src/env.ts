// Loads ./.env into process.env (if the file exists) BEFORE config.ts reads anything.
// Real environment variables always win over the file. Requires Node 20.12+ (we use 22).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file: defaults and real environment variables are used */
}
export {};
