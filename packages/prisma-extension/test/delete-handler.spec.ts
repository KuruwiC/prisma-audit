/**
 * Unit tests for `collectDeleteRecords` (nested delete handler)
 *
 * Focus: composite primary key reconstruction. When the pre-fetch step only knows
 * a serialized entityId (no full before-state), `collectDeleteRecords` must
 * reconstruct the composite key from it. A broken entityId (not valid JSON, or the
 * wrong array length) must never be recorded as a plausible-looking partial key —
 * it must be skipped and reported instead.
 */

import { UNRESOLVED_ENTITY_ID, type UniqueConstraint } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { NestedOperationInfo, NestedPreFetchResults } from '../src/grammar/nested-operations.js';
import { collectDeleteRecords } from '../src/lifecycle/nested-handlers/delete-handler.js';

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
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint);

    // A `{ tenantId: 'not-json' }` guess would look like a
    // complete, valid identity to anyone reading the audit log, when in fact the
    // itemId half of the key is unknown. Skipping the entry is the only option
    // that does not assert a wrong identity.
    expect(collected).toEqual([]);
  });

  it('does not fabricate a partial-key entity when the parsed JSON array length does not match pkFields', async () => {
    const brokenEntityId = JSON.stringify(['tenant-1']); // missing itemId
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint);

    expect(collected).toEqual([]);
  });

  it('still reconstructs the entity when the composite entityId is well-formed JSON', async () => {
    const goodEntityId = JSON.stringify(['tenant-1', 'item-1']);
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[goodEntityId, { before: null }]])]]);

    const collected = await collectDeleteRecords(nestedOp, preFetchResults, pkConstraint);

    expect(collected).toEqual([
      {
        entity: { tenantId: 'tenant-1', itemId: 'item-1' },
        action: 'delete',
        beforeState: null,
        relatedModel: 'OrderItem',
      },
    ]);
  });

  it('reports the unresolved entityId via the provided callback instead of silently dropping it', async () => {
    const brokenEntityId = 'not-json';
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);
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
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);
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
    const preFetchResults: NestedPreFetchResults = new Map([['comments', new Map([['comment-1', { before: null }]])]]);

    const collected = await collectDeleteRecords(singleFieldOp, preFetchResults, idPrimaryKey);

    expect(collected).toEqual([
      {
        entity: { id: 'comment-1' },
        action: 'delete',
        beforeState: null,
        relatedModel: 'OrderItem',
      },
    ]);
  });
});

describe('collectDeleteRecords — unresolved identity', () => {
  const commentsOp: NestedOperationInfo = { ...nestedOp, relatedModel: 'Comment', path: 'comments' };

  it('reports an entry stored under UNRESOLVED_ENTITY_ID with no entityId instead of a placeholder string', async () => {
    const preFetchResults: NestedPreFetchResults = new Map([
      ['comments', new Map([[UNRESOLVED_ENTITY_ID, { before: null }]])],
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
      ['comments', new Map([['__default__', { before: null }]])],
    ]);
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(commentsOp, preFetchResults, idPrimaryKey, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([
      { entity: { id: '__default__' }, action: 'delete', beforeState: null, relatedModel: 'Comment' },
    ]);
    expect(onUnresolvedDeleteEntityId).not.toHaveBeenCalled();
  });
});

describe('collectDeleteRecords — nested deleteMany has no single-row identity to resolve', () => {
  // Nested `deleteMany` (e.g. `posts: { deleteMany: { where: { published: false } } }`) is
  // deliberately never pre-fetched (see the "Exception" note on `collectDeleteRecords`), so
  // an ordinary filter WHERE reaches the fallback with nothing pre-fetched and no PK fields
  // present in `nestedOp.data`. That is a designed limitation, not an identity resolution
  // failure — it must not be reported through `onUnresolvedDeleteEntityId`.
  const deleteManyOp: NestedOperationInfo = {
    operation: 'deleteMany',
    fieldName: 'posts',
    relatedModel: 'Post',
    isList: true,
    data: { published: false },
    path: 'posts',
  };

  it('produces no audit entry and does not notify the observer for an ordinary filter WHERE', async () => {
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(deleteManyOp, undefined, idPrimaryKey, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).not.toHaveBeenCalled();
  });

  it('still extracts an identity and yields an entry when the WHERE names a PK field directly', async () => {
    const deleteManyByIdOp: NestedOperationInfo = { ...deleteManyOp, data: { id: 'post-1' } };
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectDeleteRecords(deleteManyByIdOp, undefined, idPrimaryKey, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([
      {
        entity: { id: 'post-1' },
        action: 'delete',
        beforeState: null,
        relatedModel: 'Post',
      },
    ]);
    expect(onUnresolvedDeleteEntityId).not.toHaveBeenCalled();
  });

  it('reports a single delete (not deleteMany) whose identity cannot be resolved through the callback', async () => {
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
