/**
 * Unit tests for the nested delete handler: `collectDeleteRecords` and `collectDeleteManyRecords`
 *
 * Focus: composite primary key reconstruction. When the pre-fetch step only knows
 * a serialized entityId (no full before-state), `collectDeleteRecords` must
 * reconstruct the composite key from it. A broken entityId (not valid JSON, or the
 * wrong array length) must never be recorded as a plausible-looking partial key —
 * it must be skipped and reported instead.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedOperationInfo, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { collectDeleteManyRecords, collectDeleteRecords } from '../../../src/nested/events/delete-handler.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';

const nestedOp: NestedOperationInfo = {
  operation: 'delete',
  fieldName: 'items',
  relatedModel: 'OrderItem',
  isList: true,
  data: { tenantId: 'tenant-1', itemId: 'item-1' },
  path: 'items',
};

const pkConstraint: UniqueConstraint = { type: 'primaryKey', fields: ['tenantId', 'itemId'] };
const idPrimaryKey: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };

describe('collectDeleteRecords — composite primary key reconstruction', () => {
  it('does not fabricate a partial-key entity when the composite entityId is not valid JSON', async () => {
    const brokenEntityId = 'not-json';
    const preFetchResults: NestedPreFetchResults = new Map([
      ['items', new Map([[brokenEntityId, { before: { kind: 'none' } }]])],
    ]);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint);

    // A `{ tenantId: 'not-json' }` guess would look like a
    // complete, valid identity to anyone reading the audit log, when in fact the
    // itemId half of the key is unknown. Skipping the entry is the only option
    // that does not assert a wrong identity.
    expect(collected).toEqual([]);
  });

  it('does not fabricate a partial-key entity when the parsed JSON array length does not match pkFields', async () => {
    const brokenEntityId = JSON.stringify(['tenant-1']); // missing itemId
    const preFetchResults: NestedPreFetchResults = new Map([
      ['items', new Map([[brokenEntityId, { before: { kind: 'none' } }]])],
    ]);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint);

    expect(collected).toEqual([]);
  });

  it('still reconstructs the entity when the composite entityId is well-formed JSON', async () => {
    const goodEntityId = JSON.stringify(['tenant-1', 'item-1']);
    const preFetchResults: NestedPreFetchResults = new Map([
      ['items', new Map([[goodEntityId, { before: { kind: 'none' } }]])],
    ]);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint);

    expect(collected).toEqual([
      {
        entity: { tenantId: 'tenant-1', itemId: 'item-1' },
        action: 'delete',
        beforeState: { kind: 'none' },
        relatedModel: 'OrderItem',
      },
    ]);
  });

  it('reports the unresolved entityId via the provided callback instead of silently dropping it', async () => {
    const brokenEntityId = 'not-json';
    const preFetchResults: NestedPreFetchResults = new Map([
      ['items', new Map([[brokenEntityId, { before: { kind: 'none' } }]])],
    ]);
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledTimes(1);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedModel: 'OrderItem',
        entityId: brokenEntityId,
        pkFields: pkConstraint.fields,
        error: expect.any(Error),
      }),
    );
  });

  it('awaits the reporter callback before returning, rather than firing it and forgetting it', async () => {
    const brokenEntityId = 'not-json';
    const preFetchResults: NestedPreFetchResults = new Map([
      ['items', new Map([[brokenEntityId, { before: { kind: 'none' } }]])],
    ]);
    let reporterResolved = false;
    const onUnresolvedDeleteEntityId = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      reporterResolved = true;
    });

    await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint, onUnresolvedDeleteEntityId);

    // If `collectDeleteRecords` only fired the callback without awaiting it, this
    // assertion would run before the callback's own microtask/timer resolved.
    expect(reporterResolved).toBe(true);
  });

  it('still reconstructs a single-field entityId unchanged (non-composite models are unaffected)', async () => {
    const singleFieldOp: NestedOperationInfo = { ...nestedOp, path: 'comments' };
    const preFetchResults: NestedPreFetchResults = new Map([
      ['comments', new Map([['comment-1', { before: { kind: 'none' } }]])],
    ]);

    const collected = await collectDeleteRecords(singleFieldOp, preFetchResults, idPrimaryKey);

    expect(collected).toEqual([
      {
        entity: { id: 'comment-1' },
        action: 'delete',
        beforeState: { kind: 'none' },
        relatedModel: 'OrderItem',
      },
    ]);
  });
});

describe('collectDeleteRecords — unresolved identity', () => {
  const commentsOp: NestedOperationInfo = { ...nestedOp, relatedModel: 'Comment', path: 'comments' };

  it('reports an entry stored under UNRESOLVED_ENTITY_ID with no entityId instead of a placeholder string', async () => {
    const preFetchResults: NestedPreFetchResults = new Map([
      ['comments', new Map([[UNRESOLVED_ENTITY_ID, { before: { kind: 'unavailable' } }]])],
    ]);
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(commentsOp, preFetchResults, idPrimaryKey, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedModel: 'Comment',
        entityId: undefined,
        error: expect.objectContaining({ message: expect.stringContaining('entityId=unresolved') }),
      }),
    );
  });

  it('treats a real primary key spelled like a placeholder as a resolved identity', async () => {
    const preFetchResults: NestedPreFetchResults = new Map([
      ['comments', new Map([['__default__', { before: { kind: 'none' } }]])],
    ]);
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(commentsOp, preFetchResults, idPrimaryKey, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([
      { entity: { id: '__default__' }, action: 'delete', beforeState: { kind: 'none' }, relatedModel: 'Comment' },
    ]);
    expect(onUnresolvedDeleteEntityId).not.toHaveBeenCalled();
  });
});

describe('collectDeleteRecords — a delete whose data names no identity', () => {
  const deleteManyOp: NestedOperationInfo = {
    operation: 'deleteMany',
    fieldName: 'posts',
    relatedModel: 'Post',
    isList: true,
    data: { published: false },
    path: 'posts',
  };

  it('reports a delete whose identity cannot be resolved through the callback', async () => {
    const singleDeleteOp: NestedOperationInfo = { ...deleteManyOp, operation: 'delete' };
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(singleDeleteOp, undefined, idPrimaryKey, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledTimes(1);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedModel: 'Post',
        entityId: undefined,
        pkFields: ['id'],
        error: expect.objectContaining({ message: expect.stringContaining('entityId=unresolved') }),
      }),
    );
  });
});

describe('collectDeleteManyRecords', () => {
  const deleteManyOp: NestedOperationInfo = {
    operation: 'deleteMany',
    fieldName: 'posts',
    relatedModel: 'Post',
    isList: true,
    data: { published: false },
    path: 'posts',
  };
  const deleteOp: NestedOperationInfo = { ...deleteManyOp, operation: 'delete', data: { id: 'post-9' } };

  it('collects a delete per row the filter matched, with the before state the pre-read captured', () => {
    const before = { id: 'post-1', published: false };

    expect(
      collectDeleteManyRecords(deleteManyOp, [
        { where: { id: 'post-1' }, operation: deleteManyOp, before: { kind: 'captured', row: before } },
      ]),
    ).toEqual([
      { entity: before, action: 'delete', beforeState: { kind: 'captured', row: before }, relatedModel: 'Post' },
    ]);
  });

  it('collects the primary key alone when the before state was not read', () => {
    expect(
      collectDeleteManyRecords(deleteManyOp, [
        { where: { id: 'post-1' }, operation: deleteManyOp, before: { kind: 'none' } },
      ]),
    ).toEqual([{ entity: { id: 'post-1' }, action: 'delete', beforeState: { kind: 'none' }, relatedModel: 'Post' }]);
  });

  it('leaves the rows of the other operations at the path to them', () => {
    expect(
      collectDeleteManyRecords(deleteManyOp, [
        { where: { id: 'post-9' }, operation: deleteOp, before: { kind: 'none' } },
      ]),
    ).toEqual([]);
  });
});
