#!/usr/bin/env node
/**
 * Checks that the supported Prisma and Node.js ranges, the compatibility workflow's matrix and the
 * README state the same thing. The peer range of `@prisma/client` in packages/prisma-extension and
 * `engines.node` in the root package.json are the sources; every other copy is derived from them.
 *
 * Prints one line per rule; each violation is one `FAIL` line, and the script then exits with status 1.
 *
 * Usage: node scripts/check-support-matrix.mjs [repo-root]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const WORKFLOW = '.github/workflows/prisma-compatibility.yml';
const MATRIX_PATH = 'jobs.compatibility.strategy.matrix.include';
const ROOT_PACKAGE = 'package.json';
const PEER_PACKAGE = 'packages/prisma-extension/package.json';
const PEER_NAME = '@prisma/client';
const README = 'README.md';
const WORKSPACE_DIRS = ['packages', 'examples'];
/** A version no real peer range admits: a range that still satisfies it has no upper bound */
const FAR_FUTURE = '999.0.0';

function read(file) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute)) {
    throw new Error(`${file}: not found under ${ROOT}`);
  }
  return readFileSync(absolute, 'utf8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function loadMatrix() {
  const include = parseYaml(read(WORKFLOW))?.jobs?.compatibility?.strategy?.matrix?.include;
  if (!Array.isArray(include) || include.length === 0) {
    throw new Error(`${WORKFLOW}: ${MATRIX_PATH} is missing or is not a non-empty list`);
  }
  return include;
}

function loadPeerRange() {
  const range = readJson(PEER_PACKAGE).peerDependencies?.[PEER_NAME];
  if (typeof range !== 'string' || semver.validRange(range) === null) {
    throw new Error(`${PEER_PACKAGE}: peerDependencies["${PEER_NAME}"] is missing or is not a valid range`);
  }
  return range;
}

function loadEngines() {
  const engines = readJson(ROOT_PACKAGE).engines?.node;
  if (typeof engines !== 'string' || semver.validRange(engines) === null) {
    throw new Error(`${ROOT_PACKAGE}: engines.node is missing or is not a valid range`);
  }
  return engines;
}

function loadPublishablePackages() {
  return WORKSPACE_DIRS.flatMap((dir) => {
    if (!existsSync(path.join(ROOT, dir))) return [];
    return readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/package.json`)
      .filter((file) => existsSync(path.join(ROOT, file)))
      .sort()
      .map((file) => ({ file, json: readJson(file) }))
      .filter(({ json }) => json.private !== true);
  });
}

function describeRow(row, index) {
  return `matrix row ${index + 1} (prisma ${JSON.stringify(row?.prisma)}, node ${JSON.stringify(row?.node)})`;
}

function hasExactVersion(row) {
  return typeof row?.prisma === 'string' && semver.valid(row.prisma) === row.prisma;
}

function hasNodeMajor(row) {
  return Number.isInteger(row?.node) && row.node >= 1;
}

function rowsInRange(rows, range) {
  return rows.filter((row) => hasExactVersion(row) && semver.satisfies(row.prisma, range));
}

function hasUpperBound(range) {
  return !semver.satisfies(FAR_FUTURE, range);
}

function checkUpperBound({ range }) {
  return hasUpperBound(range) ? [] : [`${PEER_NAME} peer range "${range}" has no upper bound`];
}

function checkRowShape({ rows }) {
  return rows.flatMap((row, index) => {
    const problems = [];
    if (!hasExactVersion(row)) {
      problems.push(`${describeRow(row, index)}: prisma is not an exact version`);
    }
    if (!hasNodeMajor(row)) {
      problems.push(`${describeRow(row, index)}: node is not an integer major`);
    }
    return problems;
  });
}

function checkRowsSatisfyRange({ rows, range }) {
  return rows.flatMap((row, index) =>
    hasExactVersion(row) && !semver.satisfies(row.prisma, range)
      ? [`${describeRow(row, index)}: prisma ${row.prisma} is outside the peer range "${range}"`]
      : [],
  );
}

function checkFloorIsTested({ rows, range }) {
  const floor = semver.minVersion(range).version;
  return rows.some((row) => row?.prisma === floor)
    ? []
    : [`peer range minimum ${floor} has no matrix row (rows: ${rows.map((row) => row?.prisma).join(', ')})`];
}

/** Majors from the peer range's minimum upward that the range admits; the range must be bounded */
function admittedMajors(range) {
  const majors = [];
  for (let major = semver.minVersion(range).major; semver.intersects(range, `${major}.x.x`); major += 1) {
    majors.push(major);
  }
  return majors;
}

function checkMajorsCovered({ rows, range }) {
  if (!hasUpperBound(range)) {
    return [`cannot enumerate the Prisma majors admitted by "${range}" without an upper bound`];
  }
  const covered = new Set(rowsInRange(rows, range).map((row) => semver.major(row.prisma)));
  return admittedMajors(range)
    .filter((major) => !covered.has(major))
    .map((major) => `Prisma ${major}.x is admitted by "${range}" but has no matrix row`);
}

function checkNodeInEngines({ rows, engines }) {
  return rows.flatMap((row, index) =>
    hasNodeMajor(row) && !semver.intersects(engines, `${row.node}.x.x`)
      ? [`${describeRow(row, index)}: Node ${row.node} is outside engines.node "${engines}"`]
      : [],
  );
}

function checkEngineAlternativesCovered({ rows, engines }) {
  const nodes = new Set(rows.map((row) => row?.node));
  return new semver.Range(engines).set.flatMap((comparators) => {
    const alternative = comparators.map((comparator) => comparator.value).join(' ');
    const { major, version } = semver.minVersion(alternative);
    return nodes.has(major)
      ? []
      : [`engines.node alternative "${alternative}" (minimum ${version}) has no matrix row on Node ${major}`];
  });
}

function checkPackageEngines({ engines, packages }) {
  return packages.flatMap(({ file, json }) => {
    const declared = json.engines?.node;
    return declared === undefined || declared === engines
      ? []
      : [`${file}: engines.node "${declared}" differs from the root "${engines}"`];
  });
}

function checkReadme({ range, engines }) {
  const readme = read(README);
  return [
    [`${PEER_NAME} peer range`, range],
    ['engines.node', engines],
  ].flatMap(([label, value]) => (readme.includes(value) ? [] : [`${README} does not contain the ${label} "${value}"`]));
}

const RULES = [
  { title: `${PEER_NAME} peer range has an upper bound`, check: checkUpperBound },
  { title: 'every matrix row has an exact prisma version and an integer node major', check: checkRowShape },
  { title: 'every matrix prisma version satisfies the peer range', check: checkRowsSatisfyRange },
  { title: "the peer range's minimum is a matrix row", check: checkFloorIsTested },
  { title: 'every Prisma major the peer range admits has a matrix row', check: checkMajorsCovered },
  { title: 'every matrix node major is inside engines.node', check: checkNodeInEngines },
  {
    title: 'every engines.node alternative has a matrix row on its minimum major',
    check: checkEngineAlternativesCovered,
  },
  { title: "publishable packages declare the root's engines.node", check: checkPackageEngines },
  { title: `${README} states the peer range and engines.node`, check: checkReadme },
];

function main() {
  const context = {
    rows: loadMatrix(),
    range: loadPeerRange(),
    engines: loadEngines(),
    packages: loadPublishablePackages(),
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
  console.log(
    `ok    ${context.rows.length} matrix rows, ${PEER_NAME} "${context.range}", engines.node "${context.engines}"`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
