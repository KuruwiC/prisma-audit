import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Keep compiled build output (dist/) out of the test run
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
