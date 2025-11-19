import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 60000,
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
  },
});
