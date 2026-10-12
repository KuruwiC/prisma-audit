#!/usr/bin/env node
/**
 * Aligns the `datasource db` block of the three fixture schemas with the Prisma
 * major under test: Prisma 6 requires `url = env("DATABASE_URL")` in the schema,
 * Prisma 7 rejects it (the URL comes from prisma.config.ts). The committed
 * schemas follow the repository's default Prisma version (no `url`); the
 * compatibility workflow runs this script before installing another major.
 *
 * Idempotent. Exits non-zero when a schema has no `datasource db` block.
 *
 * Usage: node scripts/sync-datasource-url.mjs <prisma-version>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMAS = [
  'packages/database/prisma/schema.prisma',
  'packages/integration-tests/prisma/schema.sqlite.prisma',
  'packages/integration-tests/prisma/schema.mysql.prisma',
];

const URL_LINE = '  url      = env("DATABASE_URL")';
const DATASOURCE_BLOCK = /(^datasource\s+db\s*\{)([^}]*)(\})/m;
const URL_PROPERTY = /^[ \t]*url[ \t]*=.*\r?\n?/m;

function parseMajor(version) {
  const match = /^(\d+)\.\d+\.\d+/.exec(version ?? '');
  if (!match) {
    throw new Error(`Expected a Prisma version such as 7.10.0, got "${version ?? ''}"`);
  }
  return Number(match[1]);
}

function syncSource(source, major, file) {
  const block = DATASOURCE_BLOCK.exec(source);
  if (!block) {
    throw new Error(`${file}: no "datasource db { ... }" block found`);
  }
  const [whole, open, body, close] = block;
  const hasUrl = URL_PROPERTY.test(body);

  if (major >= 7) {
    return hasUrl ? source.replace(whole, () => `${open}${body.replace(URL_PROPERTY, '')}${close}`) : source;
  }
  if (hasUrl) {
    return source;
  }
  const trimmed = body.replace(/\s+$/, '');
  return source.replace(whole, () => `${open}${trimmed}\n${URL_LINE}\n${close}`);
}

function main() {
  const major = parseMajor(process.argv[2]);
  // Every schema is validated before any is written, so a failure leaves all of them untouched.
  const updates = SCHEMAS.map((relative) => {
    const file = path.join(ROOT, relative);
    const source = readFileSync(file, 'utf8');
    return { relative, file, source, next: syncSource(source, major, relative) };
  });
  for (const { relative, file, source, next } of updates) {
    if (next !== source) {
      writeFileSync(file, next);
    }
    console.log(`${relative}: ${next === source ? 'unchanged' : major >= 7 ? 'url removed' : 'url added'}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
