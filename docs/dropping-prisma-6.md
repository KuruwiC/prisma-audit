# Dropping Prisma 6 support

`@kuruwic/prisma-audit` supports Prisma 6.16 and later 6.x releases alongside Prisma 7. Dropping Prisma 6 changes the declared peer range, the compatibility workflow and the documentation. No file under `packages/*/src` changes.

## Why the source does not change

- **Models come from a build-time file.** `@kuruwic/prisma-audit-generator` runs during `prisma generate` and writes the models' keys and relations to the file the application passes as `schema: auditSchema`. It reads only the `datamodel` Prisma hands a generator, which has the same shape on Prisma 6 and 7. The extension reads that file, not Prisma's runtime internals.
- **Prisma is injected.** The application passes its own `PrismaClient` and `Prisma` namespace to the extension. `packages/prisma-extension/src` imports nothing from `@prisma/*`, so where Prisma 6 and 7 put the generated client is the application's concern.
- **The schemas already follow Prisma 7.** The committed fixture schemas have no `datasource.url`; `prisma.config.ts` supplies it. Only the Prisma 6 rows of the compatibility workflow rewrite them, with `scripts/sync-datasource-url.mjs`.

The one Prisma version check in `packages/*/src`, `supportsQueryOmit` in `packages/prisma-extension/src/utils/prisma-version.ts`, tests for Prisma 6.2 (query `omit`). Every supported client passes it, with or without Prisma 6, so it stays as it is.

## Steps

1. In `packages/prisma-extension/package.json`, set the `@prisma/client` peer range to `>=7.0.0 <8.0.0`.
2. In `.github/workflows/prisma-compatibility.yml`:
   - delete the `6.x` rows of `jobs.compatibility.strategy.matrix.include`;
   - delete the `node scripts/sync-datasource-url.mjs ${{ matrix.prisma }}` line of the "Override Prisma version" step.
3. Delete `scripts/sync-datasource-url.mjs`.
4. Update the documentation: replace `>=6.16.0 <8.0.0` with `>=7.0.0 <8.0.0` in `README.md` and `packages/prisma-extension/README.md`, remove the `6.x` versions from the "Tested in CI" cell of the Prisma row in the README's Compatibility table, and rewrite the other statements of Prisma 6 support, including the prebuild comment above `include` in the workflow. To find them:

   ```bash
   git grep -nE "6\.16|Prisma 6|6\.x" -- README.md 'packages/*/README.md' docs .github
   ```

   The "Current" column of [docs/migration-guide.md](migration-guide.md) states the peer range too. Delete this page and its link in the README's "Upgrading" section.
5. Add a changeset (`pnpm changeset`): raising the peer floor breaks installs on Prisma 6.
6. Verify:

   ```bash
   pnpm check:support-matrix
   pnpm build
   pnpm typecheck
   pnpm check:invariants
   pnpm --filter @kuruwic/prisma-audit-integration-tests test:sqlite
   ```

`pnpm check:support-matrix` fails until steps 1, 2 and 4 agree: it reports a matrix row outside the peer range, a README that still states the old peer range, and a "Tested in CI" cell that differs from the matrix.

Optional: `packages/integration-tests/test/helpers/setup-sqlite.ts` also accepts `PrismaBetterSQLite3`, the class name `@prisma/adapter-better-sqlite3` exports up to Prisma 6. It is test code and keeps working on Prisma 7; the fallback can be removed with the rest.
