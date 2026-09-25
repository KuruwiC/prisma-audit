/**
 * Primary-key derivation and entity-identity helpers of the nested-write grammar
 */

import { UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import {
  deserializeEntityId,
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  refetchNestedRecords,
} from '../../src/grammar/nested-operations.js';
import type { FieldMetadata, SchemaMetadata, UniqueConstraint } from '../../src/schema/types.js';

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

const metadataFor = (models: Record<string, ModelShape>, relationsOfPost: string[] = []): SchemaMetadata => ({
  getUniqueConstraints: (modelName) => models[modelName]?.constraints ?? [],
  getRelationFields: (modelName) =>
    modelName === 'Post'
      ? relationsOfPost.map((relatedModel) => ({
          name: relatedModel.toLowerCase(),
          relatedModel,
          isList: true,
          isRequired: false,
        }))
      : [],
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

describe('refetchNestedRecords — primary key of the related model', () => {
  const nestedOperationOn = (relatedModel: string): NestedOperationInfo => ({
    fieldName: relatedModel.toLowerCase(),
    relatedModel,
    operation: 'update',
    isList: true,
    data: {},
    path: relatedModel.toLowerCase(),
  });

  const preFetchedAt = (path: string): NestedPreFetchResults =>
    new Map([[path, new Map([['row-1', { before: { id: 'row-1', key: 'row-1' } }]])]]);

  it('refetches by the @id field of the related model', async () => {
    const findMany = vi.fn(async () => [{ id: 'row-1' }]);
    const metadata = metadataFor({ Label: { fields: [scalarField('id', true)] } }, ['Label']);

    const records = await refetchNestedRecords({ label: { findMany } }, metadata, 'Post', preFetchedAt('label'), [
      nestedOperationOn('Label'),
    ]);

    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ['row-1'] } } });
    expect(records).toEqual([
      { fieldName: 'label', relatedModel: 'Label', isList: true, records: [{ id: 'row-1' }], path: 'label' },
    ]);
  });

  it('propagates a failed refetch', async () => {
    const readError = new Error('findMany failed');
    const findMany = vi.fn(async () => {
      throw readError;
    });
    const metadata = metadataFor({ Label: { fields: [scalarField('id', true)] } }, ['Label']);

    await expect(
      refetchNestedRecords({ label: { findMany } }, metadata, 'Post', preFetchedAt('label'), [
        nestedOperationOn('Label'),
      ]),
    ).rejects.toBe(readError);
  });

  it('skips the refetch when the related model has no primary key', async () => {
    const findMany = vi.fn(async () => [{ key: 'row-1' }]);
    const metadata = metadataFor(
      { Setting: { constraints: [{ type: 'uniqueField', fields: ['key'] }], fields: [scalarField('key')] } },
      ['Setting'],
    );

    const records = await refetchNestedRecords({ setting: { findMany } }, metadata, 'Post', preFetchedAt('setting'), [
      nestedOperationOn('Setting'),
    ]);

    expect(findMany).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });
});
