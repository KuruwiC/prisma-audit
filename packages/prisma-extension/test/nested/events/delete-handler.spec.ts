/**
 * Unit tests for the nested delete handler: `collectToOneDeleteRecords` and
 * `collectToManyDeleteRecords`
 *
 * To-one: the deleted row is the related row read under the delete's own parent row; when it
 * could not be read the delete is skipped and reported, and when nothing was read the primary
 * key comes from the operation data, never as a plausible-looking partial key.
 *
 * To-many: each target of the operation yields its deleted row, from the row read ahead of the
 * write or from the primary key its locator or WHERE holds.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedOperationInfo, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import { collectToManyDeleteRecords, collectToOneDeleteRecords } from '../../../src/nested/events/delete-handler.js';
import { markPathUnread, storePreFetchResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';

const nestedOp: NestedOperationInfo = {
  operation: 'delete',
  fieldName: 'items',
  relatedModel: 'OrderItem',
  isList: false,
  data: true,
  path: 'items',
};

const pkConstraint: UniqueConstraint = { type: 'primaryKey', fields: ['tenantId', 'itemId'] };
const idPrimaryKey: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };

describe('collectToOneDeleteRecords — the row read under its parent row', () => {
  const notesOp: NestedOperationInfo = {
    ...nestedOp,
    relatedModel: 'Note',
    path: 'bookmarks.note',
    data: true,
  };
  const preFetched = (): NestedPreFetchResults => {
    const results: NestedPreFetchResults = new Map();
    storePreFetchResult(results, 'bookmarks.note', {
      before: { kind: 'captured', row: { id: 'note-1', body: 'one' } },
      identity: 'note-1',
      name: { by: 'parentRow', parent: 'bookmark-1' },
    });
    storePreFetchResult(results, 'bookmarks.note', {
      before: { kind: 'captured', row: { id: 'note-2', body: 'two' } },
      identity: 'note-2',
      name: { by: 'parentRow', parent: 'bookmark-2' },
    });
    storePreFetchResult(results, 'bookmarks.note', {
      before: { kind: 'none' },
      identity: UNRESOLVED_ENTITY_ID,
      name: { by: 'parentRow', parent: 'bookmark-3' },
    });
    return results;
  };

  it('records the related row of its own parent row only, with its before state', async () => {
    expect(await collectToOneDeleteRecords(notesOp, 'bookmark-2', preFetched(), idPrimaryKey)).toEqual([
      {
        entity: { id: 'note-2', body: 'two' },
        action: 'delete',
        beforeState: { kind: 'captured', row: { id: 'note-2', body: 'two' } },
        relatedModel: 'Note',
      },
    ]);
  });

  it('records nothing under a parent row that had no related row', async () => {
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    expect(
      await collectToOneDeleteRecords(notesOp, 'bookmark-3', preFetched(), idPrimaryKey, onUnresolvedDeleteEntityId),
    ).toEqual([]);
    expect(onUnresolvedDeleteEntityId).not.toHaveBeenCalled();
  });
});

describe('collectToOneDeleteRecords — unresolved identity', () => {
  const commentsOp: NestedOperationInfo = { ...nestedOp, relatedModel: 'Comment', path: 'comments' };
  const unread = (): NestedPreFetchResults => {
    const results: NestedPreFetchResults = new Map();
    markPathUnread(results, 'comments');
    return results;
  };

  it('reports a delete whose row could not be read with no entityId instead of a placeholder string', async () => {
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectToOneDeleteRecords(
      commentsOp,
      TOP_LEVEL_ROW,
      unread(),
      idPrimaryKey,
      onUnresolvedDeleteEntityId,
    );

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledTimes(1);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedModel: 'Comment',
        entityId: undefined,
        pkFields: ['id'],
        error: expect.objectContaining({ message: expect.stringContaining('entityId=unresolved') }),
      }),
    );
  });

  it('awaits the reporter callback before returning, rather than firing it and forgetting it', async () => {
    let reporterResolved = false;
    const onUnresolvedDeleteEntityId = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      reporterResolved = true;
    });

    await collectToOneDeleteRecords(commentsOp, TOP_LEVEL_ROW, unread(), idPrimaryKey, onUnresolvedDeleteEntityId);

    // If `collectToOneDeleteRecords` only fired the callback without awaiting it, this
    // assertion would run before the callback's own microtask/timer resolved.
    expect(reporterResolved).toBe(true);
  });
});

describe('collectToOneDeleteRecords — nothing pre-fetched', () => {
  it('reconstructs a composite primary key from the compound-unique WHERE in the operation data', async () => {
    const byKey: NestedOperationInfo = {
      ...nestedOp,
      data: { tenantId_itemId: { tenantId: 'tenant-1', itemId: 'item-1' } },
    };

    expect(await collectToOneDeleteRecords(byKey, TOP_LEVEL_ROW, undefined, pkConstraint)).toEqual([
      {
        entity: { tenantId: 'tenant-1', itemId: 'item-1' },
        action: 'delete',
        beforeState: { kind: 'none' },
        relatedModel: 'OrderItem',
      },
    ]);
  });

  it('treats a real primary key spelled like a placeholder as a resolved identity', async () => {
    const commentsOp: NestedOperationInfo = {
      ...nestedOp,
      relatedModel: 'Comment',
      path: 'comments',
      data: { id: '__default__' },
    };
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectToOneDeleteRecords(
      commentsOp,
      TOP_LEVEL_ROW,
      undefined,
      idPrimaryKey,
      onUnresolvedDeleteEntityId,
    );

    expect(collected).toEqual([
      { entity: { id: '__default__' }, action: 'delete', beforeState: { kind: 'none' }, relatedModel: 'Comment' },
    ]);
    expect(onUnresolvedDeleteEntityId).not.toHaveBeenCalled();
  });
});

describe('collectToOneDeleteRecords — a delete whose data names no identity', () => {
  it('reports a delete whose identity cannot be resolved through the callback', async () => {
    const singleDeleteOp: NestedOperationInfo = {
      operation: 'delete',
      fieldName: 'profile',
      relatedModel: 'Post',
      isList: false,
      data: true,
      path: 'profile',
    };
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);

    const collected = await collectToOneDeleteRecords(
      singleDeleteOp,
      TOP_LEVEL_ROW,
      undefined,
      idPrimaryKey,
      onUnresolvedDeleteEntityId,
    );

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

describe('collectToManyDeleteRecords', () => {
  const deleteManyOp: NestedOperationInfo = {
    operation: 'deleteMany',
    fieldName: 'posts',
    relatedModel: 'Post',
    isList: true,
    data: { published: false },
    path: 'posts',
  };
  const deleteOp: NestedOperationInfo = { ...deleteManyOp, operation: 'delete', data: { id: 'post-9' } };

  it('collects a delete per row the filter matched, with the before state the pre-read captured', async () => {
    const before = { id: 'post-1', published: false };

    expect(
      await collectToManyDeleteRecords(
        deleteManyOp,
        [
          {
            locator: { by: 'primaryKey', where: { id: 'post-1' } },
            operation: deleteManyOp,
            element: undefined,
            before: { kind: 'captured', row: before },
          },
        ],
        idPrimaryKey,
      ),
    ).toEqual([
      { entity: before, action: 'delete', beforeState: { kind: 'captured', row: before }, relatedModel: 'Post' },
    ]);
  });

  it('collects the primary key alone when the before state was not read', async () => {
    expect(
      await collectToManyDeleteRecords(
        deleteManyOp,
        [
          {
            locator: { by: 'primaryKey', where: { id: 'post-1' } },
            operation: deleteManyOp,
            element: undefined,
            before: { kind: 'none' },
          },
        ],
        idPrimaryKey,
      ),
    ).toEqual([{ entity: { id: 'post-1' }, action: 'delete', beforeState: { kind: 'none' }, relatedModel: 'Post' }]);
  });

  it('leaves the rows of the other operations at the path to them', async () => {
    expect(
      await collectToManyDeleteRecords(
        deleteManyOp,
        [
          {
            locator: { by: 'uniqueWhere', where: { id: 'post-9' } },
            operation: deleteOp,
            element: 0,
            before: { kind: 'none' },
          },
        ],
        idPrimaryKey,
      ),
    ).toEqual([]);
  });

  it('derives the primary key of a delete from its compound-unique WHERE, keeping an unavailable before state', async () => {
    const itemsOp: NestedOperationInfo = { ...deleteOp, relatedModel: 'OrderItem', path: 'items' };

    expect(
      await collectToManyDeleteRecords(
        itemsOp,
        [
          {
            locator: { by: 'uniqueWhere', where: { tenantId_itemId: { tenantId: 'tenant-1', itemId: 'item-1' } } },
            operation: itemsOp,
            element: 0,
            before: { kind: 'unavailable' },
          },
        ],
        pkConstraint,
      ),
    ).toEqual([
      {
        entity: { tenantId: 'tenant-1', itemId: 'item-1' },
        action: 'delete',
        beforeState: { kind: 'unavailable' },
        relatedModel: 'OrderItem',
      },
    ]);
  });

  it('reports and skips a delete whose WHERE names no primary key and whose row was not read', async () => {
    const onUnresolvedDeleteEntityId = vi.fn().mockResolvedValue(undefined);
    const byTitle: NestedOperationInfo = { ...deleteOp, data: { title: 'unique title' } };

    const collected = await collectToManyDeleteRecords(
      byTitle,
      [
        {
          locator: { by: 'uniqueWhere', where: { title: 'unique title' } },
          operation: byTitle,
          element: 0,
          before: { kind: 'unavailable' },
        },
      ],
      idPrimaryKey,
      onUnresolvedDeleteEntityId,
    );

    expect(collected).toEqual([]);
    expect(onUnresolvedDeleteEntityId).toHaveBeenCalledWith(
      expect.objectContaining({ relatedModel: 'Post', entityId: undefined, pkFields: ['id'] }),
    );
  });
});
