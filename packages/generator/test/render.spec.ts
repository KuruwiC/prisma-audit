import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuditSchema } from '@kuruwic/prisma-audit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderAuditSchemaFiles } from '../src/render.js';
import { toAuditSchema } from '../src/to-audit-schema.js';
import { loadFixtureDatamodel } from './support/fixture-datamodel.js';

const tempDirs: string[] = [];

const writeRendered = async (schema: AuditSchema): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-schema-render-'));
  tempDirs.push(dir);
  for (const [fileName, content] of Object.entries(renderAuditSchemaFiles(schema))) {
    await writeFile(join(dir, fileName), content);
  }
  return dir;
};

describe('renderAuditSchemaFiles', () => {
  let schema: AuditSchema;

  beforeAll(async () => {
    schema = toAuditSchema(await loadFixtureDatamodel());
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes the three files of the output directory', () => {
    expect(Object.keys(renderAuditSchemaFiles(schema)).sort()).toStrictEqual([
      'index.d.ts',
      'index.js',
      'package.json',
    ]);
  });

  it('writes an index.js whose auditSchema export equals the data it was given', async () => {
    const dir = await writeRendered(schema);

    const loaded = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'index.js')).href)) as {
      auditSchema: unknown;
    };

    expect(loaded.auditSchema).toStrictEqual(schema);
  });

  it('marks the output directory as an ES module so a CommonJS project still loads index.js', () => {
    expect(JSON.parse(renderAuditSchemaFiles(schema)['package.json'])).toStrictEqual({ type: 'module' });
  });

  it('declares the model-name union and a schema typed by it, importing the contract type-only', () => {
    const declaration = renderAuditSchemaFiles(schema)['index.d.ts'];

    expect(declaration).toContain("import type { AuditSchema } from '@kuruwic/prisma-audit';");
    expect(declaration).toContain(
      "export type AuditModelName = 'Author' | 'Profile' | 'Post' | 'Category' | 'PostLike' | 'PostBookmark' | 'Device' | 'ApiToken' | 'LegacyEvent';",
    );
    expect(declaration).toContain('export declare const auditSchema: AuditSchema<AuditModelName>;');
  });

  it('declares an empty union for a schema without models', () => {
    const declaration = renderAuditSchemaFiles({ formatVersion: 1, models: [] })['index.d.ts'];

    expect(declaration).toContain('export type AuditModelName = never;');
  });

  it('renders the same bytes every time for the same data', async () => {
    const again = toAuditSchema(await loadFixtureDatamodel());

    expect(renderAuditSchemaFiles(again)).toStrictEqual(renderAuditSchemaFiles(schema));
  });

  it('embeds no timestamp and no Prisma version', () => {
    const files = Object.values(renderAuditSchemaFiles(schema)).join('\n');

    expect(files).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(files).not.toMatch(/\d+\.\d+\.\d+/);
  });
});
