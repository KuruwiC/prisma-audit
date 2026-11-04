/**
 * Options checked once when they are normalized: the `schema` option, the audit schema the
 * extension reads every model's structure from, the `write` option, and the
 * diff-exclusion and redaction options, and the entity map keys of `recordOmittedFields`
 */

import type { WriteMode } from '@kuruwic/db-audit-core';
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

describe('the write option', () => {
  const withWrite = (write: PrismaAuditExtensionOptions['write']): PrismaAuditExtensionOptions => ({
    ...optionsWith(userSchema),
    write,
  });

  it('defaults to the atomic write mode for every model', () => {
    expect(normalizeAuditOptions(withWrite(undefined)).policyConfig).toEqual({ mode: 'atomic' });
  });

  it('passes the value or function forms of mode to the write policy unchanged', () => {
    const mode = (modelName: string): WriteMode => (modelName === 'User' ? 'atomic' : 'deferred');

    expect(normalizeAuditOptions(withWrite({ mode: 'deferred' })).policyConfig.mode).toBe('deferred');
    expect(normalizeAuditOptions(withWrite({ mode })).policyConfig.mode).toBe(mode);
  });
});

describe('the diffExcludeFields and redactFields options', () => {
  const withOptions = (options: Partial<PrismaAuditExtensionOptions>): PrismaAuditExtensionOptions => ({
    ...optionsWith(userSchema),
    ...options,
  });

  it('defaults to no diff exclusions and no redactFields', () => {
    const { composeConfig } = normalizeAuditOptions(withOptions({}));

    expect(composeConfig.diffExcludeFields).toEqual([]);
    expect(composeConfig.redactFields).toEqual([]);
  });

  it('passes diffExcludeFields, redactFields and serializers to the record composition unchanged', () => {
    const serializers = [(value: unknown) => value];
    const { composeConfig } = normalizeAuditOptions(
      withOptions({ diffExcludeFields: ['updatedAt'], redactFields: ['phone'], serializers }),
    );

    expect(composeConfig.diffExcludeFields).toEqual(['updatedAt']);
    expect(composeConfig.redactFields).toEqual(['phone']);
    expect(composeConfig.serializers).toBe(serializers);
  });

  it('rejects a field both in the global diffExcludeFields and in redactFields', () => {
    expect(() =>
      normalizeAuditOptions(withOptions({ diffExcludeFields: ['updatedAt', 'phone'], redactFields: ['phone'] })),
    ).toThrow("Fields cannot be both in 'diffExcludeFields' and 'redactFields'. Conflicting fields: phone.");
  });

  it("rejects a field both in an entity's diffExcludeFields and in redactFields", () => {
    const entities = { User: defineEntity({ type: 'User', diffExcludeFields: ['phone'] }) };

    expect(() => normalizeAuditOptions(withOptions({ entities, redactFields: ['phone'] }))).toThrow(
      "Configuration error for model 'User': Fields cannot be both in entity 'diffExcludeFields' and 'redactFields'. Conflicting fields: phone.",
    );
  });

  it('accepts redactFields next to an entity diffExcludeFields that names other fields', () => {
    const entities = { User: defineEntity({ type: 'User', diffExcludeFields: ['updatedAt'] }) };

    expect(() => normalizeAuditOptions(withOptions({ entities, redactFields: ['phone'] }))).not.toThrow();
  });
});

describe('the recordOmittedFields option', () => {
  it('accepts recordOmittedFields on an entity map key that names its model in another case, and reads the field', () => {
    const schema = auditSchema(model('auditEvent', [column('id', { isId: true, isRequired: true }), column('secret')]));
    const options = {
      contextProvider: createAsyncLocalStorageProvider(),
      entities: { AuditEvent: defineEntity({ type: 'AuditEvent', recordOmittedFields: ['secret'] }) },
      Prisma: { ...Prisma, prismaVersion: { client: '6.19.0' } },
      schema,
    } as PrismaAuditExtensionOptions;

    const audit = normalizeAuditOptions(options);

    expect([...audit.auditedOmittedFields.of('auditEvent')]).toEqual(['secret']);
  });
});
