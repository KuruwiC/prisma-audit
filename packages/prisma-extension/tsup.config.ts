import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
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
  noExternal: [
    '@kuruwic/prisma-audit-core',
    '@paralleldrive/cuid2',
    '@noble/hashes',
    '@bugsnag/cuid',
    // @bugsnag/cuid resolves its fingerprint via a package subpath import
    /^#fingerprint$/,
    'uuid',
    'bignumber.js',
    'error-causes',
  ],
  skipNodeModulesBundle: true,
});
