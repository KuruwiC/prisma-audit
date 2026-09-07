#!/usr/bin/env node
/**
 * Runs publint and @arethetypeswrong/cli (attw) against every tarball in a
 * directory, so a hand-written `exports` map with no test coverage still
 * gets checked before a release ships.
 *
 * Both packages here are ESM-only by design (no `require` condition), so
 * attw runs under its `esm-only` profile: the node10/CJS resolution checks
 * it would otherwise report do not apply to a package that never claims to
 * support `require()`.
 *
 * Usage: node scripts/lint-tarballs.mjs <tarball-dir>
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { listTarballs } from './lib/tarballs.mjs';

const PUBLINT_VERSION = '0.3.24';
const ATTW_VERSION = '0.18.5';

function main() {
  const tarballDirArg = process.argv[2];
  if (!tarballDirArg) {
    console.error('Usage: node scripts/lint-tarballs.mjs <tarball-dir>');
    process.exit(1);
  }

  const tarballDir = path.resolve(tarballDirArg);
  const tarballs = listTarballs(tarballDir);

  if (tarballs.length === 0) {
    console.error(`No tarballs found in ${tarballDir}`);
    process.exit(1);
  }

  for (const tarball of tarballs) {
    const name = path.basename(tarball);

    console.log(`\n--- publint: ${name} ---`);
    execFileSync('npx', ['--yes', `publint@${PUBLINT_VERSION}`, 'run', tarball], {
      stdio: 'inherit',
    });

    console.log(`\n--- attw --profile esm-only: ${name} ---`);
    execFileSync('npx', ['--yes', `@arethetypeswrong/cli@${ATTW_VERSION}`, '--profile', 'esm-only', tarball], {
      stdio: 'inherit',
    });
  }
}

main();
