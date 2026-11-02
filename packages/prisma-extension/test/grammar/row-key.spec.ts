/**
 * Row-key derivation and entity-identity helpers of the nested-write grammar
 */

import { describe, expect, it } from 'vitest';
import { deserializeEntityId, getRowKeyConstraint } from '../../src/grammar/nested-operations.js';
import { UNRESOLVED_ENTITY_ID } from '../../src/utils/identity-key.js';
import { column, model, schemaMetadataOf } from '../support/audit-schema.js';

describe('getRowKeyConstraint', () => {
  it('returns the @id field, with a null name, when the model declares no @@id', () => {
    const metadata = schemaMetadataOf(
      model('User', [column('id', { isId: true }), column('email', { isUnique: true })]),
    );

    expect(getRowKeyConstraint(metadata, 'User')).toEqual({ type: 'primaryKey', fields: ['id'], name: null });
  });

  it('keeps the declared name of a named @@id', () => {
    const metadata = schemaMetadataOf(
      model('PostBookmark', [column('postId'), column('userId')], {
        primaryKey: { fields: ['postId', 'userId'], name: 'bookmarkKey' },
      }),
    );

    expect(getRowKeyConstraint(metadata, 'PostBookmark')).toEqual({
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: 'bookmarkKey',
    });
  });

  it('returns an unnamed @@id with a null name', () => {
    const metadata = schemaMetadataOf(
      model('PostLike', [column('postId'), column('userId')], {
        primaryKey: { fields: ['postId', 'userId'], name: null },
      }),
    );

    expect(getRowKeyConstraint(metadata, 'PostLike')).toEqual({
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: null,
    });
  });

  it('returns the primary key ahead of a unique field on a required column', () => {
    const metadata = schemaMetadataOf(
      model('User', [
        column('email', { isUnique: true, isRequired: true }),
        column('id', { isId: true, isRequired: true }),
      ]),
    );

    expect(getRowKeyConstraint(metadata, 'User')).toEqual({ type: 'primaryKey', fields: ['id'], name: null });
  });

  it('returns the first @unique field on a required column of a model without a primary key', () => {
    const metadata = schemaMetadataOf(
      model('Device', [column('serial', { isUnique: true }), column('code', { isUnique: true, isRequired: true })]),
    );

    expect(getRowKeyConstraint(metadata, 'Device')).toEqual({ type: 'uniqueField', fields: ['code'], name: null });
  });

  it('returns a @@unique on required columns, with the name Prisma keys its WHERE by, skipping one with a nullable column', () => {
    const metadata = schemaMetadataOf(
      model(
        'DeviceSensor',
        [column('deviceCode', { isRequired: true }), column('slot', { isRequired: true }), column('alias')],
        {
          uniqueIndexes: [
            { fields: ['deviceCode', 'alias'], name: null },
            { fields: ['deviceCode', 'slot'], name: 'sensorKey' },
          ],
        },
      ),
    );

    expect(getRowKeyConstraint(metadata, 'DeviceSensor')).toEqual({
      type: 'uniqueIndex',
      fields: ['deviceCode', 'slot'],
      name: 'sensorKey',
    });
  });

  it('returns undefined for a model with no primary key and no unique constraint on required columns', () => {
    const metadata = schemaMetadataOf(model('Setting', [column('key', { isUnique: true })]));

    expect(getRowKeyConstraint(metadata, 'Setting')).toBeUndefined();
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

  it.each(['{"tenantId":"tenant-1","itemId":"item-1"}', '"tenant-1"', '42', 'null'])(
    'returns null when the composite identity %s parses to something other than an array',
    (entityId) => {
      expect(deserializeEntityId(entityId, ['tenantId', 'itemId'])).toBeNull();
    },
  );

  it('returns null when the parsed composite identity has a different length than the key', () => {
    expect(deserializeEntityId(JSON.stringify(['tenant-1']), ['tenantId', 'itemId'])).toBeNull();
  });

  it('returns null for the unresolved identity', () => {
    expect(deserializeEntityId(UNRESOLVED_ENTITY_ID, ['id'])).toBeNull();
  });
});
