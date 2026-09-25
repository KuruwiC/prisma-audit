#!/usr/bin/env node
/**
 * Checks that @kuruwic/db-audit-core stays independent of any ORM:
 *
 * 1. `Prisma` and `Drizzle` appear nowhere in the core's source, in any letter case, comments included.
 * 2. No ORM operation vocabulary (`findUnique`, `createMany`, `upsert`, `dmmf`, ...) appears as a
 *    whole word in the core's source. `where`, `include` and `select` are ordinary English words
 *    and are not checked.
 * 3. The core's only runtime dependency is `debug`.
 * 4. No type in the core is inferred from the shape of a database client (`extends { findMany ...`).
 * 5. Only `context-provider.ts` references the `AsyncLocalStorage` identifier; comments and string or
 *    regular expression literals do not count.
 * 6. How often `dmmf` appears in the other packages' source is reported, without failing.
 *
 * Prints one line per check; a failing check's line is followed by each violation as
 * `file:line: text`, and the script then exits with status 1.
 *
 * Usage: node scripts/check-core-invariants.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = 'packages/db-audit-core';
const CORE_SRC = `${CORE_DIR}/src`;
const CORE_PACKAGE_JSON = `${CORE_DIR}/package.json`;
const CONTEXT_PROVIDER = `${CORE_SRC}/context-provider.ts`;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'generated']);

const ORM_NAME = /prisma|drizzle/gi;
const ORM_VOCABULARY =
  /\b(findUnique|findMany|findFirst|connectOrCreate|createMany|updateMany|deleteMany|createManyAndReturn|updateManyAndReturn|upsert|dmmf|DMMF)\b/g;
const CLIENT_SHAPE_INFERENCE = /extends \{\s*(findUnique|findMany|create|update|delete)\b/g;
const ASYNC_LOCAL_STORAGE = /\bAsyncLocalStorage\b/g;
const DMMF = /dmmf/g;

/** Characters after which a `/` starts a regular expression literal rather than a division */
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^']);

function read(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

/** Lists every file under `dir` (repo-relative), skipping dependency, build and generated directories */
function listFiles(dir) {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : listFiles(file);
      return entry.isFile() ? [file] : [];
    })
    .sort();
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Returns one violation per line on which `pattern` matches `searched`. A match spanning lines is
 * reported on its first line. `source` supplies the reported text and must have the same layout.
 */
function findMatches(file, pattern, searched, source = searched) {
  const lines = source.split('\n');
  const lineNumbers = new Set([...searched.matchAll(pattern)].map((match) => lineNumberAt(searched, match.index)));
  return [...lineNumbers].map((line) => ({ file, line, text: lines[line - 1].trim() }));
}

function scan(files, pattern, prepare = (source) => source) {
  return files.flatMap((file) => {
    const source = read(file);
    return findMatches(file, pattern, prepare(source), source);
  });
}

function quotedEnd(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') i += 2;
    else if (ch === quote) return i + 1;
    else if (ch === '\n' && quote !== '`') return i;
    else i += 1;
  }
  return source.length;
}

function regexEnd(source, start) {
  let inClass = false;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') i += 2;
    else if (ch === '\n') return i;
    else if (ch === '/' && !inClass) return i + 1;
    else {
      if (ch === '[') inClass = true;
      if (ch === ']') inClass = false;
      i += 1;
    }
  }
  return source.length;
}

function commentEnd(source, start) {
  const opener = source.slice(start, start + 2);
  if (opener === '//') {
    const end = source.indexOf('\n', start);
    return end === -1 ? source.length : end;
  }
  if (opener === '/*') {
    const end = source.indexOf('*/', start + 2);
    return end === -1 ? source.length : end + 2;
  }
  return -1;
}

function literalEnd(source, start, previous) {
  const ch = source[start];
  if (ch === '"' || ch === "'" || ch === '`') return quotedEnd(source, start);
  if (ch === '/' && (previous === '' || REGEX_PRECEDERS.has(previous))) return regexEnd(source, start);
  return -1;
}

/** Returns where the token at `start` ends, whether it is a comment or a literal, and the last significant character */
function tokenAt(source, start, previous) {
  const commentStop = commentEnd(source, start);
  if (commentStop !== -1) return { end: commentStop, blank: true, previous };
  const literalStop = literalEnd(source, start, previous);
  if (literalStop !== -1) return { end: literalStop, blank: true, previous: source[start] };
  const ch = source[start];
  return { end: start + 1, blank: false, previous: /\s/.test(ch) ? previous : ch };
}

/** Replaces the characters of comments and literals, except newlines, with spaces, keeping offsets and line numbers */
function codeOnly(source) {
  const chars = source.split('');
  let previous = '';
  let i = 0;
  while (i < source.length) {
    const token = tokenAt(source, i, previous);
    if (token.blank) {
      for (let k = i; k < token.end; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
    }
    previous = token.previous;
    i = token.end;
  }
  return chars.join('');
}

function checkDependencies() {
  const source = read(CORE_PACKAGE_JSON);
  const names = Object.keys(JSON.parse(source).dependencies ?? {});
  if (isDeepStrictEqual(names, ['debug'])) return [];
  const index = source.indexOf('"dependencies"');
  return [
    {
      file: CORE_PACKAGE_JSON,
      line: index === -1 ? 1 : lineNumberAt(source, index),
      text: `dependencies are ${JSON.stringify(names)}, expected ["debug"]`,
    },
  ];
}

function countDmmfOutsideCore() {
  const sourceDirs = readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && `packages/${entry.name}` !== CORE_DIR)
    .map((entry) => `packages/${entry.name}/src`)
    .filter((dir) => existsSync(path.join(ROOT, dir)));
  const matches = scan(sourceDirs.flatMap(listFiles), DMMF);
  return { lines: matches.length, files: new Set(matches.map((match) => match.file)).size };
}

function main() {
  const coreFiles = listFiles(CORE_SRC);
  const checks = [
    {
      title: `no Prisma or Drizzle in ${CORE_SRC} (${coreFiles.length} files, any case, comments included)`,
      violations: scan(coreFiles, ORM_NAME),
    },
    {
      title: `no ORM operation vocabulary in ${CORE_SRC}`,
      violations: scan(coreFiles, ORM_VOCABULARY),
    },
    {
      title: `${CORE_PACKAGE_JSON} depends only on debug`,
      violations: checkDependencies(),
    },
    {
      title: `no type in ${CORE_SRC} inferred from a database client shape`,
      violations: scan(coreFiles, CLIENT_SHAPE_INFERENCE),
    },
    {
      title: `AsyncLocalStorage identifier referenced only in ${CONTEXT_PROVIDER}`,
      violations: scan(
        coreFiles.filter((file) => file !== CONTEXT_PROVIDER),
        ASYNC_LOCAL_STORAGE,
        codeOnly,
      ),
    },
  ];

  let failed = false;
  for (const { title, violations } of checks) {
    if (violations.length === 0) {
      console.log(`ok    ${title}`);
      continue;
    }
    failed = true;
    console.error(`FAIL  ${title}`);
    for (const { file, line, text } of violations) console.error(`${file}:${line}: ${text}`);
  }

  const dmmf = countDmmfOutsideCore();
  console.log(`info  dmmf appears on ${dmmf.lines} lines in ${dmmf.files} files of packages/*/src outside the core`);

  if (failed) process.exit(1);
}

main();
