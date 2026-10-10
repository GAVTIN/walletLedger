import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    fileParallelism: false, // each file clones its own database, but we keep CPU predictable
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
