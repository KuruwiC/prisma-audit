/**
 * Unit tests for `collectDeleteRecords` (nested delete handler)
 *
 * Focus: composite primary key reconstruction. When the pre-fetch step only knows
 * a serialized entityId (no full before-state), `collectDeleteRecords` must
 * reconstruct the composite key from it. A broken entityId (not valid JSON, or the
 * wrong array length) must never be recorded as a plausible-looking partial key —
 * it must be skipped and reported instead.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  collectDeleteRecords,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../src/lifecycle/nested-handlers/delete-handler.js';

const nestedOp: NestedOperationInfo = {
  operation: 'delete',
  fieldName: 'items',
  relatedModel: 'OrderItem',
  data: { tenantId: 'tenant-1', itemId: 'item-1' },
  path: 'items',
};

const pkFields = ['tenantId', 'itemId'];

describe('collectDeleteRecords — composite primary key reconstruction', () => {
  it('does not fabricate a partial-key entity when the composite entityId is not valid JSON', () => {
    const brokenEntityId = 'not-json';
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);

    const collected = collectDeleteRecords(nestedOp, preFetchResults, pkFields);

    // A `{ tenantId: 'not-json' }` guess would look like a
    // complete, valid identity to anyone reading the audit log, when in fact the
    // itemId half of the key is unknown. Skipping the entry is the only option
    // that does not assert a wrong identity.
    expect(collected).toEqual([]);
  });

  it('does not fabricate a partial-key entity when the parsed JSON array length does not match pkFields', () => {
    const brokenEntityId = JSON.stringify(['tenant-1']); // missing itemId
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);

    const collected = collectDeleteRecords(nestedOp, preFetchResults, pkFields);

    expect(collected).toEqual([]);
  });

  it('still reconstructs the entity when the composite entityId is well-formed JSON', () => {
    const goodEntityId = JSON.stringify(['tenant-1', 'item-1']);
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[goodEntityId, { before: null }]])]]);

    const collected = collectDeleteRecords(nestedOp, preFetchResults, pkFields);

    expect(collected).toEqual([
      {
        entity: { tenantId: 'tenant-1', itemId: 'item-1' },
        action: 'delete',
        beforeState: null,
        relatedModel: 'OrderItem',
      },
    ]);
  });

  it('reports the unresolved entityId via the provided callback instead of silently dropping it', () => {
    const brokenEntityId = 'not-json';
    const preFetchResults: NestedPreFetchResults = new Map([['items', new Map([[brokenEntityId, { before: null }]])]]);
    const onUnresolvedDeleteEntityId = vi.fn();

    const collected = collectDeleteRecords(nestedOp, preFetchResults, pkFields, onUnresolvedDeleteEntityId);

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledTimes(1);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedModel: 'OrderItem',
        entityId: brokenEntityId,
        pkFields,
        error: expect.any(Error),
      }),
    );
  });

  it('still reconstructs a single-field entityId unchanged (non-composite models are unaffected)', () => {
    const singleFieldOp: NestedOperationInfo = { ...nestedOp, path: 'comments' };
    const preFetchResults: NestedPreFetchResults = new Map([['comments', new Map([['comment-1', { before: null }]])]]);

    const collected = collectDeleteRecords(singleFieldOp, preFetchResults, ['id']);

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
