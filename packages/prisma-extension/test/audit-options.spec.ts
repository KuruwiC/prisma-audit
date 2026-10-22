/**
 * The `schema` option: the audit schema the extension reads every model's structure from, checked
 * once when the options are normalized
 */

import { createAsyncLocalStorageProvider, defineEntity } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { normalizeAuditOptions } from '../src/audit-options.js';
import type { PrismaAuditExtensionOptions } from '../src/types.js';
import { auditSchema, column, model } from './support/audit-schema.js';

const Prisma = { defineExtension: (extension: unknown) => extension, DbNull: null };

/** Options whose `schema` comes from a caller the option types do not reach: plain JavaScript, or options assembled at runtime */
const optionsWith = (schema: unknown) =>
  ({
    contextProvider: createAsyncLocalStorageProvider(),
    entities: { User: defineEntity({ type: 'User' }) },
    Prisma,
    schema,
  }) as PrismaAuditExtensionOptions;

const userSchema = auditSchema(
  model('User', [
    column('id', { isId: true, isRequired: true, hasDefaultValue: true, default: { name: 'cuid', args: [1] } }),
  ]),
);

const MISSING_SCHEMA_MESSAGE = [
  '[@prisma-audit] The "schema" option is missing. Add this generator block to schema.prisma:',
  '',
  'generator audit {',
  '  provider = "prisma-audit-generator"',
  '  output   = "../generated/audit"',
  '}',
  '',
  'then run `prisma generate` and pass `schema: auditSchema`, imported from that output.',
].join('\n');

const NOT_AN_AUDIT_SCHEMA_MESSAGE =
  '[@prisma-audit] The "schema" option has no numeric formatVersion, so it is not an audit schema. Pass the ' +
  "exported `auditSchema` itself, imported from the generator's output (`import { auditSchema } from " +
  "'<output>/index.js'`), not the module or an object that holds it.";

describe('the schema option', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['not an object', 'audit'],
  ])('rejects a schema that is %s with the steps that produce one', (_label, schema) => {
    expect(() => normalizeAuditOptions(optionsWith(schema))).toThrow(MISSING_SCHEMA_MESSAGE);
  });

  it('rejects a schema of another format version, naming both versions', () => {
    expect(() => normalizeAuditOptions(optionsWith({ formatVersion: 2, models: [] }))).toThrow(
      '[@prisma-audit] The "schema" option has formatVersion 2; this version of @kuruwic/prisma-audit reads ' +
        'formatVersion 1. Install the @kuruwic/prisma-audit-generator version that matches @kuruwic/prisma-audit ' +
        'and rerun `prisma generate`.',
    );
  });

  it.each([
    ['an object holding it', { auditSchema: userSchema }],
    ['the module namespace of the output', { auditSchema: userSchema, [Symbol.toStringTag]: 'Module' }],
    ['a schema whose format version is not a number', { formatVersion: '1', models: [] }],
  ])('rejects %s, asking for the exported auditSchema itself', (_label, schema) => {
    expect(() => normalizeAuditOptions(optionsWith(schema))).toThrow(NOT_AN_AUDIT_SCHEMA_MESSAGE);
  });

  it('answers queries about its models', () => {
    const { schemaMetadata } = normalizeAuditOptions(optionsWith(userSchema));

    expect(schemaMetadata.getModelNames()).toEqual(['User']);
    expect(schemaMetadata.getFieldMetadata('User', 'id')?.isId).toBe(true);
  });
});
