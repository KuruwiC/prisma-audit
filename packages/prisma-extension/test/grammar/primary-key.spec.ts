/**
 * Primary-key derivation and entity-identity helpers of the nested-write grammar
 */

import { describe, expect, it } from 'vitest';
import { deserializeEntityId, getPrimaryKeyConstraint } from '../../src/grammar/nested-operations.js';
import { UNRESOLVED_ENTITY_ID } from '../../src/utils/identity-key.js';
import { column, model, schemaMetadataOf } from '../support/audit-schema.js';

describe('getPrimaryKeyConstraint', () => {
  it('returns the @id field, with a null name, when the model declares no @@id', () => {
    const metadata = schemaMetadataOf(
      model('User', [column('id', { isId: true }), column('email', { isUnique: true })]),
    );

    expect(getPrimaryKeyConstraint(metadata, 'User')).toEqual({ type: 'primaryKey', fields: ['id'], name: null });
  });

  it('keeps the declared name of a named @@id', () => {
    const metadata = schemaMetadataOf(
      model('PostBookmark', [column('postId'), column('userId')], {
        primaryKey: { fields: ['postId', 'userId'], name: 'bookmarkKey' },
      }),
    );

    expect(getPrimaryKeyConstraint(metadata, 'PostBookmark')).toEqual({
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

    expect(getPrimaryKeyConstraint(metadata, 'PostLike')).toEqual({
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: null,
    });
  });

  it('returns undefined for a model without a primary key', () => {
    const metadata = schemaMetadataOf(model('Setting', [column('key', { isUnique: true })]));

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
