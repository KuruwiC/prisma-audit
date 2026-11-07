/**
 * Options checked once when they are normalized: the `schema` option, the audit schema the
 * extension reads every model's structure from, the `write` option and the models the audit rows
 * are written to, the diff-exclusion and redaction options, and the entity map keys of
 * `recordOmittedFields`
 */

import { createAsyncLocalStorageProvider, defineEntity, policy } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { normalizeAuditOptions } from '../src/audit-options.js';
import type { PrismaAuditExtensionOptions } from '../src/types.js';
import { createEntityNormalizedWriter, createSharedChangeWriter } from '../src/utils/normalized-writer.js';
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
    expect(policy(['User'], normalizeAuditOptions(withWrite(undefined)).policyConfig)).toBe('atomic');
  });

  it("writes a model by its entity's writeMode, and one whose entity sets none by mode", () => {
    const { policyConfig } = normalizeAuditOptions({
      ...withWrite({ mode: 'awaited' }),
      entities: { User: defineEntity({ type: 'User', writeMode: 'deferred' }), Post: defineEntity({ type: 'Post' }) },
    });

    expect(policy(['User'], policyConfig)).toBe('deferred');
    expect(policy(['Post'], policyConfig)).toBe('awaited');
  });
});

describe('the models the audit rows are written to', () => {
  const withEntities = (
    entityKeys: readonly string[],
    write: PrismaAuditExtensionOptions['write'],
  ): PrismaAuditExtensionOptions => ({
    ...optionsWith(userSchema),
    entities: Object.fromEntries(entityKeys.map((key) => [key, defineEntity({ type: key })])),
    write,
  });
  const reentrantDestination = (modelName: string, source: string) =>
    `Configuration error: 'entities' lists ${modelName}, which the audit rows are written to (${source}). ` +
    "The audit's own write to it would be rejected as a write issued while the audit processes an operation, " +
    `losing the records of every audited write. Remove ${modelName} from 'entities'.`;

  it.each([
    {
      label: 'the default audit-log model, AuditLog',
      entityKey: 'AuditLog',
      write: undefined,
      modelName: 'AuditLog',
      source: 'write.model',
    },
    {
      label: 'the write.model model, in another case',
      entityKey: 'activity',
      write: { model: 'Activity' },
      modelName: 'Activity',
      source: 'write.model',
    },
    {
      label: 'the write.model model next to a custom writer',
      entityKey: 'Activity',
      write: { model: 'Activity', writer: async () => {} },
      modelName: 'Activity',
      source: 'write.model',
    },
  ])('rejects an entity map that lists $label', ({ entityKey, write, modelName, source }) => {
    expect(() => normalizeAuditOptions(withEntities(['User', entityKey], write))).toThrow(
      reentrantDestination(modelName, source),
    );
  });

  const entityNormalized = createEntityNormalizedWriter({
    actorModel: 'actor',
    entityModel: 'entity',
    aggregateModel: 'aggregate',
    eventModel: 'auditEvent',
  });
  const sharedChange = createSharedChangeWriter({ changeModel: 'auditChange', aggregateModel: 'auditAggregate' });

  it.each([
    {
      label: 'the actor model of the entity-normalized writer',
      writer: entityNormalized,
      entityKey: 'Actor',
      modelName: 'actor',
    },
    {
      label: 'the entity model of the entity-normalized writer',
      writer: entityNormalized,
      entityKey: 'Entity',
      modelName: 'entity',
    },
    {
      label: 'the aggregate model of the entity-normalized writer',
      writer: entityNormalized,
      entityKey: 'Aggregate',
      modelName: 'aggregate',
    },
    {
      label: 'the event model of the entity-normalized writer',
      writer: entityNormalized,
      entityKey: 'AuditEvent',
      modelName: 'auditEvent',
    },
    {
      label: 'the change model of the shared-change writer',
      writer: sharedChange,
      entityKey: 'AuditChange',
      modelName: 'auditChange',
    },
    {
      label: 'the aggregate model of the shared-change writer',
      writer: sharedChange,
      entityKey: 'AuditAggregate',
      modelName: 'auditAggregate',
    },
  ])('rejects an entity map that lists $label', ({ writer, entityKey, modelName }) => {
    expect(() => normalizeAuditOptions(withEntities(['User', entityKey], { writer }))).toThrow(
      reentrantDestination(modelName, 'write.writer'),
    );
  });

  it('accepts an entity map that lists AuditLog next to a writer when write.model names no model', () => {
    const custom: NonNullable<PrismaAuditExtensionOptions['write']>['writer'] = async () => {};

    expect(() => normalizeAuditOptions(withEntities(['User', 'AuditLog'], { writer: custom }))).not.toThrow();
    expect(() => normalizeAuditOptions(withEntities(['User', 'AuditLog'], { writer: sharedChange }))).not.toThrow();
  });

  it('accepts a normalized writer and a custom writer next to an entity map of other models', () => {
    const custom: NonNullable<PrismaAuditExtensionOptions['write']>['writer'] = async () => {};

    expect(() => normalizeAuditOptions(withEntities(['User', 'Post'], { writer: entityNormalized }))).not.toThrow();
    expect(() => normalizeAuditOptions(withEntities(['User', 'Post'], { writer: sharedChange }))).not.toThrow();
    expect(() => normalizeAuditOptions(withEntities(['User', 'Post'], { writer: custom }))).not.toThrow();
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
