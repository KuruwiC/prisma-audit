#!/usr/bin/env node
/**
 * Installs every packed tarball together, in a directory outside the
 * workspace, using only the public npm registry as a fallback source. This
 * reproduces exactly what an end user does after `npm install @kuruwic/...`
 * and catches a tarball that declares a dependency on a workspace package
 * which was never published (the bug this check exists for).
 *
 * After install, it imports the `@kuruwic/prisma-audit` entry point and
 * asserts a known export is present, so a broken `exports` map fails too.
 *
 * Usage: node scripts/verify-tarball-install.mjs <tarball-dir> <work-dir>
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listTarballs } from './lib/tarballs.mjs';

const PACKAGE_TO_IMPORT = '@kuruwic/prisma-audit';
const EXPECTED_EXPORT = 'createAuditClient';

function main() {
  const [tarballDirArg, workDirArg] = process.argv.slice(2);
  if (!tarballDirArg || !workDirArg) {
    console.error('Usage: node scripts/verify-tarball-install.mjs <tarball-dir> <work-dir>');
    process.exit(1);
  }

  const tarballDir = path.resolve(tarballDirArg);
  const workDir = path.resolve(workDirArg);

  const tarballs = listTarballs(tarballDir);

  if (tarballs.length === 0) {
    console.error(`No tarballs found in ${tarballDir}`);
    process.exit(1);
  }

  console.log(`Installing ${tarballs.length} tarball(s) into ${workDir}:`);
  for (const tarball of tarballs) {
    console.log(`  - ${path.basename(tarball)}`);
  }

  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    path.join(workDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'prisma-audit-tarball-smoke-test',
        version: '0.0.0',
        private: true,
      },
      null,
      2,
    )}\n`,
  );

  // The public registry is the only other source npm can reach here; any
  // dependency on a workspace package that was left out of the publish set
  // fails to resolve instead of silently succeeding via the workspace.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', ...tarballs], {
    cwd: workDir,
    stdio: 'inherit',
  });

  const checkScriptPath = path.join(workDir, 'check-import.mjs');
  writeFileSync(
    checkScriptPath,
    `const mod = await import(${JSON.stringify(PACKAGE_TO_IMPORT)});
if (typeof mod.${EXPECTED_EXPORT} !== 'function') {
  console.error('Expected export "${EXPECTED_EXPORT}" to be a function, got:', typeof mod.${EXPECTED_EXPORT});
  process.exit(1);
}
console.log('OK: ${PACKAGE_TO_IMPORT} exports ${EXPECTED_EXPORT}');
`,
  );

  execFileSync('node', [checkScriptPath], { cwd: workDir, stdio: 'inherit' });
  console.log(`Smoke test passed in ${workDir}`);
}

main();
