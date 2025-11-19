import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
  noExternal: [],
  external: ['@prisma/client', '@kuruwic/prisma-audit-core', /^\.\.\/generated\/client/],
});
