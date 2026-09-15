#!/usr/bin/env node
/**
 * Packs every publishable (non-private) workspace package into a destination
 * directory, mirroring what a real `pnpm -r publish` would ship.
 *
 * The publish set is read from `pnpm ls -r --json` at run time, so renamed,
 * added, or newly private packages need no change here.
 *
 * Usage: node scripts/pack-publishable.mjs <destination-dir>
 * Prints the absolute path of each produced tarball to stdout, one per line.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { listTarballs } from './lib/tarballs.mjs';

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
      stdio: ['ignore', 2, 'inherit'],
    });
  }

  const tarballs = listTarballs(absDestDir);

  for (const tarball of tarballs) {
    console.log(tarball);
  }
}

main();
