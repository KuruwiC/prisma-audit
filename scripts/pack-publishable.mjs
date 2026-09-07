#!/usr/bin/env node
/**
 * Packs every publishable (non-private) workspace package into a destination
 * directory, mirroring what a real `pnpm -r publish` would ship.
 *
 * The publish set is derived from `pnpm ls -r --json` rather than a
 * hardcoded package list, so it keeps working as packages are renamed,
 * added, or marked private.
 *
 * Usage: node scripts/pack-publishable.mjs <destination-dir>
 * Prints the absolute path of each produced tarball to stdout, one per line.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

function listWorkspacePackages() {
  const output = execFileSync('pnpm', ['ls', '-r', '--json', '--depth', '-1'], {
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function main() {
  const destDir = process.argv[2];
  if (!destDir) {
    console.error('Usage: node scripts/pack-publishable.mjs <destination-dir>');
    process.exit(1);
  }

  const absDestDir = path.resolve(destDir);
  mkdirSync(absDestDir, { recursive: true });

  const publishable = listWorkspacePackages().filter((pkg) => pkg.private !== true);

  if (publishable.length === 0) {
    console.error('No publishable (non-private) workspace packages found.');
    process.exit(1);
  }

  for (const pkg of publishable) {
    console.error(`Packing ${pkg.name}@${pkg.version} (${pkg.path})`);
    execFileSync('pnpm', ['pack', '--pack-destination', absDestDir], {
      cwd: pkg.path,
      stdio: 'inherit',
    });
  }

  const tarballs = readdirSync(absDestDir)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => path.join(absDestDir, file))
    .sort();

  for (const tarball of tarballs) {
    console.log(tarball);
  }
}

main();
