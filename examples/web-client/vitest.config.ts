import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@api': path.resolve(__dirname, '../hono-api/src'),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
