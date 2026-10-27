#!/usr/bin/env node
/**
 * Checks the references of docs/guarantees.md, the reference for what the audit guarantees:
 *
 * 1. Table A, Table B and the accuracy table of the Prisma extension section exist, each found by
 *    its heading, with at least one data row.
 * 2. Every data row of those tables cites at least one test.
 * 3. The file of every test the document cites, as [`name`](path): "title", exists.
 * 4. That file declares a test of that title with `it(` or `test(` (`.each(...)(` and `.only(`
 *    included) that is not skipped: a declaration with `.skip` or `.todo` does not count, and a file
 *    that holds `describe.skip` fails as a whole.
 * 5. The Core contract section holds none of the ORM names and vocabulary the core's source may not
 *    hold, no Prisma client method (`$transaction` and the other `$` names) or
 *    `implicitTransaction`, and no Prisma error code (`P2034`).
 *
 * It checks references only. Whether a cited test proves the row that cites it is for review.
 *
 * Prints one line per rule; each violation is one `FAIL` line, and the script then exits with status 1.
 *
 * Usage: node scripts/check-guarantees.mjs [repo-root]
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ORM_NAME, ORM_VOCABULARY } from './lib/orm-vocabulary.mjs';

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const DOC = 'docs/guarantees.md';
const CORE_SECTION = '## Core contract (@kuruwic/db-audit-core)';
const PRISMA_SECTION = '## Prisma 6.16–7.x extension (@kuruwic/prisma-audit)';
const PROVEN_TABLES = [
  '### Table A: by operation',
  '### Table B: by execution context',
  '### Accuracy of Prisma operations under concurrent writes',
];
/** A test reference: group 1 is the path, relative to the document; group 2 the test title */
const TEST_REFERENCE = /\]\(([^)\s]+)\): "([^"]+)"/g;
const PRISMA_CLIENT_API = /\$[A-Za-z_]\w*|\bimplicitTransaction\b/g;
const PRISMA_ERROR_CODE = /\bP\d{4}\b/g;
const CORE_SECTION_PATTERNS = [ORM_NAME, ORM_VOCABULARY, PRISMA_CLIENT_API, PRISMA_ERROR_CODE];
const TEST_FUNCTIONS = new Set(['it', 'test']);
const SKIPPING_MODIFIERS = new Set(['skip', 'todo']);

function read(file) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute)) {
    throw new Error(`${file}: not found under ${ROOT}`);
  }
  return readFileSync(absolute, 'utf8');
}

/**
 * The lines of the section `heading` opens among `lines`, up to the next heading of the same or a
 * higher level; undefined when no line is that heading
 */
function section(lines, heading) {
  const start = lines.findIndex(({ text }) => text.trim() === heading);
  if (start === -1) return undefined;
  const level = heading.indexOf(' ');
  const length = lines.slice(start + 1).findIndex(({ text }) => /^#+ /.test(text) && text.indexOf(' ') <= level);
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length);
}

/** The data rows of the first table of a section: the table lines after its separator line */
function tableRows(sectionLines) {
  const first = sectionLines.findIndex(({ text }) => text.trimStart().startsWith('|'));
  if (first === -1) return [];
  const length = sectionLines.slice(first).findIndex(({ text }) => !text.trimStart().startsWith('|'));
  const table = sectionLines.slice(first, length === -1 ? undefined : first + length);
  return table.slice(2);
}

function referencesIn(text) {
  return [...text.matchAll(TEST_REFERENCE)].map((match) => ({ target: match[1], title: match[2] }));
}

function checkSections({ lines }) {
  return [CORE_SECTION, PRISMA_SECTION]
    .filter((heading) => section(lines, heading) === undefined)
    .map((heading) => `${DOC} has no "${heading}" heading`);
}

function provenTables({ lines }) {
  const prisma = section(lines, PRISMA_SECTION) ?? [];
  return PROVEN_TABLES.map((heading) => {
    const tableSection = section(prisma, heading);
    return { heading, rows: tableSection && tableRows(tableSection) };
  });
}

function checkTablesPresent(context) {
  return provenTables(context).flatMap(({ heading, rows }) => {
    if (rows === undefined) return [`${DOC}: no "${heading}" under "${PRISMA_SECTION}"`];
    return rows.length > 0 ? [] : [`${DOC}: "${heading}" has no table with a data row`];
  });
}

function checkRowsCiteTests(context) {
  return provenTables(context).flatMap(({ heading, rows }) =>
    (rows ?? [])
      .filter(({ text }) => referencesIn(text).length === 0)
      .map(({ number, text }) => `${DOC}:${number}: a row of "${heading}" cites no test: ${text.slice(0, 80)}`),
  );
}

function allReferences({ lines }) {
  return lines.flatMap(({ number, text }) =>
    referencesIn(text).map(({ target, title }) => ({
      line: number,
      file: path.relative(ROOT, path.resolve(ROOT, path.dirname(DOC), target)),
      title,
    })),
  );
}

function checkReferencedFilesExist(context) {
  return allReferences(context)
    .filter(({ file }) => !existsSync(path.join(ROOT, file)))
    .map(({ line, file }) => `${DOC}:${line}: ${file} does not exist`);
}

/** The callee of a test declaration as its names: `it.each([...])` gives `['it', 'each']` */
function calleeNames(expression) {
  if (ts.isCallExpression(expression)) return calleeNames(expression.expression);
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const object = calleeNames(expression.expression);
    return object && [...object, expression.name.text];
  }
  return undefined;
}

/** The titles a test file declares with `it` or `test`, without the skipped ones, and whether it holds `describe.skip` */
function declarations(file) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const titles = new Set();
  let skipsSuite = false;
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && calleeNames(node)?.join('.').startsWith('describe.skip')) {
      skipsSuite = true;
    }
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const names = calleeNames(node.expression);
      if (
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        names &&
        TEST_FUNCTIONS.has(names[0]) &&
        !names.some((name) => SKIPPING_MODIFIERS.has(name))
      ) {
        titles.add(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { titles, skipsSuite };
}

function checkTitlesDeclared(context) {
  const cache = new Map();
  const declared = (file) => {
    if (!cache.has(file)) cache.set(file, declarations(file));
    return cache.get(file);
  };
  return allReferences(context)
    .filter(({ file }) => existsSync(path.join(ROOT, file)))
    .flatMap(({ line, file, title }) => {
      const { titles, skipsSuite } = declared(file);
      if (skipsSuite) return [`${DOC}:${line}: ${file} holds describe.skip`];
      return titles.has(title)
        ? []
        : [`${DOC}:${line}: ${file} declares no test that is not skipped titled "${title}"`];
    });
}

function checkCoreVocabulary({ lines }) {
  return (section(lines, CORE_SECTION) ?? []).flatMap(({ number, text }) =>
    CORE_SECTION_PATTERNS.some((pattern) => [...text.matchAll(pattern)].length > 0)
      ? [`${DOC}:${number}: ${text.trim()}`]
      : [],
  );
}

const RULES = [
  { title: `${DOC} has the Core contract and the Prisma extension sections`, check: checkSections },
  { title: 'the proven tables of the Prisma extension section exist with data rows', check: checkTablesPresent },
  { title: 'every row of the proven tables cites a test', check: checkRowsCiteTests },
  { title: 'every cited test file exists', check: checkReferencedFilesExist },
  { title: 'every cited title is a test the file declares and does not skip', check: checkTitlesDeclared },
  {
    title: 'the Core contract section holds no ORM vocabulary, Prisma client API or Prisma error code',
    check: checkCoreVocabulary,
  },
];

function main() {
  const context = {
    lines: read(DOC)
      .split('\n')
      .map((text, index) => ({ number: index + 1, text })),
  };

  let failed = false;
  for (const { title, check } of RULES) {
    const violations = check(context);
    if (violations.length === 0) {
      console.log(`ok    ${title}`);
      continue;
    }
    failed = true;
    for (const violation of violations) console.error(`FAIL  ${title}: ${violation}`);
  }

  if (failed) process.exit(1);
  console.log(`ok    ${allReferences(context).length} test references in ${DOC}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
