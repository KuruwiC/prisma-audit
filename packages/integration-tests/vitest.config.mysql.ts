import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/smoke/**/*.mysql.smoke.spec.ts'],
    testTimeout: 60000,
    // MySQL setup starts a container, pushes the schema, and regenerates the client;
    // this exceeds vitest's default 10s hook timeout.
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
