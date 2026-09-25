/**
 * Primary-key derivation and entity-identity helpers of the nested-write grammar, and the post-operation re-fetch of nested rows
 */

import { describe, expect, it, vi } from 'vitest';
import { deserializeEntityId, getPrimaryKeyConstraint } from '../../src/grammar/nested-operations.js';
import { refetchNestedRecords } from '../../src/nested/events/refetch-nested-records.js';
import type { FieldMetadata, SchemaMetadata, UniqueConstraint } from '../../src/schema/types.js';
import { UNRESOLVED_ENTITY_ID } from '../../src/utils/identity-key.js';

const scalarField = (name: string, isId = false): FieldMetadata => ({
  name,
  type: 'String',
  kind: 'scalar',
  isRequired: true,
  isUnique: false,
  isId,
  isList: false,
  hasDefaultValue: false,
});

interface ModelShape {
  constraints?: UniqueConstraint[];
  fields?: FieldMetadata[];
}

const metadataFor = (models: Record<string, ModelShape>): SchemaMetadata => ({
  getUniqueConstraints: (modelName) => models[modelName]?.constraints ?? [],
  getRelationFields: () => [],
  getAllFields: (modelName) => models[modelName]?.fields ?? [],
  getFieldMetadata: (modelName, fieldName) => models[modelName]?.fields?.find((field) => field.name === fieldName),
});

describe('getPrimaryKeyConstraint', () => {
  it('returns the @id field when the model declares no @@id', () => {
    const metadata = metadataFor({
      User: {
        constraints: [{ type: 'uniqueField', fields: ['email'] }],
        fields: [scalarField('id', true), scalarField('email')],
      },
    });

    expect(getPrimaryKeyConstraint(metadata, 'User')).toEqual({ type: 'primaryKey', fields: ['id'] });
  });

  it('keeps the declared name of a named @@id', () => {
    const metadata = metadataFor({
      PostBookmark: {
        constraints: [{ type: 'primaryKey', fields: ['postId', 'userId'], name: 'bookmarkKey' }],
        fields: [scalarField('postId'), scalarField('userId')],
      },
    });

    expect(getPrimaryKeyConstraint(metadata, 'PostBookmark')).toEqual({
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: 'bookmarkKey',
    });
  });

  it('returns an unnamed @@id with a null name', () => {
    const metadata = metadataFor({
      PostLike: {
        constraints: [{ type: 'primaryKey', fields: ['postId', 'userId'], name: null }],
        fields: [scalarField('postId'), scalarField('userId')],
      },
    });

    expect(getPrimaryKeyConstraint(metadata, 'PostLike')).toEqual({
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: null,
    });
  });

  it('returns undefined for a model without a primary key', () => {
    const metadata = metadataFor({
      Setting: {
        constraints: [{ type: 'uniqueField', fields: ['key'] }],
        fields: [scalarField('key')],
      },
    });

    expect(getPrimaryKeyConstraint(metadata, 'Setting')).toBeUndefined();
  });
});

describe('deserializeEntityId', () => {
  it('maps a single-field identity to that field', () => {
    expect(deserializeEntityId('abc', ['id'])).toEqual({ id: 'abc' });
  });

  it('treats a real id spelled "__default__" as a resolved identity', () => {
    expect(deserializeEntityId('__default__', ['id'])).toEqual({ id: '__default__' });
  });

  it('maps a composite identity to its fields in order', () => {
    expect(deserializeEntityId(JSON.stringify(['tenant-1', 'item-1']), ['tenantId', 'itemId'])).toEqual({
      tenantId: 'tenant-1',
      itemId: 'item-1',
    });
  });

  it('returns null for a composite identity that is not valid JSON', () => {
    expect(deserializeEntityId('not-json', ['tenantId', 'itemId'])).toBeNull();
  });

  it('returns null when the parsed composite identity has a different length than the key', () => {
    expect(deserializeEntityId(JSON.stringify(['tenant-1']), ['tenantId', 'itemId'])).toBeNull();
  });

  it('returns null for the unresolved identity', () => {
    expect(deserializeEntityId(UNRESOLVED_ENTITY_ID, ['id'])).toBeNull();
  });
});

describe('refetchNestedRecords', () => {
  const stored = [
    { id: 'row-1', key: 'k-1' },
    { id: 'row-2', key: 'k-2' },
  ];
  const clientStoring = () => ({
    findUnique: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        stored.find((row) => row.id === where.id || row.key === where.key) ?? null,
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) => stored.find((row) => row.id === where.id) ?? null,
    ),
  });

  it('reads a row located by its unique WHERE with findUnique', async () => {
    const client = clientStoring();

    const rows = await refetchNestedRecords(client, [{ by: 'uniqueWhere', where: { key: 'k-2' } }]);

    expect(client.findUnique).toHaveBeenCalledWith({ where: { key: 'k-2' } });
    expect(client.findFirst).not.toHaveBeenCalled();
    expect(rows).toEqual([{ id: 'row-2', key: 'k-2' }]);
  });

  it('reads a row located by its primary key with findFirst', async () => {
    const client = clientStoring();

    const rows = await refetchNestedRecords(client, [{ by: 'primaryKey', where: { id: 'row-1' } }]);

    expect(client.findFirst).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    expect(client.findUnique).not.toHaveBeenCalled();
    expect(rows).toEqual([{ id: 'row-1', key: 'k-1' }]);
  });

  it('yields nothing for a row not found after the operation', async () => {
    const rows = await refetchNestedRecords(clientStoring(), [
      { by: 'uniqueWhere', where: { id: 'gone' } },
      { by: 'uniqueWhere', where: { id: 'row-1' } },
    ]);

    expect(rows).toEqual([{ id: 'row-1', key: 'k-1' }]);
  });

  it('propagates a failed read', async () => {
    const readError = new Error('findUnique failed');
    const client = {
      findUnique: vi.fn(async () => {
        throw readError;
      }),
      findFirst: vi.fn(),
    };

    await expect(refetchNestedRecords(client, [{ by: 'uniqueWhere', where: { id: 'row-1' } }])).rejects.toBe(readError);
  });
});
