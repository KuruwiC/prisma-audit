import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    resolve: true,
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  external: ['@prisma/client'],
  skipNodeModulesBundle: true,
});
