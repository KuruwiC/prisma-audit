/**
 * Tests for the snapshot of the rows a to-many relation holds before a nested create.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import type { ShouldFetchBefore } from '../../../src/grammar/pre-fetch-selection.js';
import type { PrismaBaseClient } from '../../../src/internal-types.js';
import { buildNestedWriteSets, detectExecutedNestedOperations } from '../../../src/nested/events/write-set.js';
import { snapshotPreExistingRows } from '../../../src/nested/pre-fetch/pre-existing-rows.js';
import { storePreFetchResult, storeUnreadRows } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { NO_AUDITED_OMITTED_FIELDS } from '../../../src/utils/audited-omitted-fields.js';
import { column, model, relation, schemaMetadataOf } from '../../support/audit-schema.js';

const schemaMetadata = schemaMetadataOf(
  model('User', [column('id', { isId: true }), relation('posts', 'Post', 'UserPosts', { isList: true })]),
  model('Post', [
    column('id', { isId: true }),
    column('authorId'),
    relation('author', 'User', 'UserPosts', { foreignKeyFields: ['authorId'], referencedFields: ['id'] }),
    relation('comments', 'Comment', 'PostComments', { isList: true }),
  ]),
  model('Comment', [
    column('id', { isId: true }),
    column('postId'),
    relation('post', 'Post', 'PostComments', { foreignKeyFields: ['postId'], referencedFields: ['id'] }),
  ]),
);
const shouldFetchBefore = () => true;

const clientWith = (delegates: Record<string, Record<string, unknown>>): PrismaBaseClient => ({
  $transaction: async () => {
    throw new Error('not used');
  },
  $extends: () => {
    throw new Error('not used');
  },
  ...delegates,
});

const snapshot = (
  args: Record<string, unknown>,
  delegates: Record<string, Record<string, unknown>>,
  nestedPreFetchResults: NestedPreFetchResults = new Map(),
  fetchesBefore: ShouldFetchBefore = shouldFetchBefore,
) => {
  const nestedOperations = detectExecutedNestedOperations(
    schemaMetadata,
    'User',
    args,
    undefined,
    nestedPreFetchResults,
  );
  return snapshotPreExistingRows(
    {
      prismaClient: clientWith(delegates),
      modelName: 'User',
      topLevelWhere: args.where,
      nestedOperations,
      writeSets: buildNestedWriteSets(schemaMetadata, nestedOperations, nestedPreFetchResults, new Map()),
      nestedPreFetchResults,
    },
    { schemaMetadata, shouldFetchBefore: fetchesBefore, auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS },
  );
};

describe('snapshotPreExistingRows', () => {
  it('snapshots the primary keys the relation holds under the parent the top-level WHERE names', async () => {
    const findMany = vi.fn(async () => [{ id: 'p1' }, { id: 'p2' }]);

    const preExisting = await snapshot(
      { where: { id: 'u1' }, data: { posts: { create: { title: 'A' } } } },
      { user: { findUnique: vi.fn(), findFirst: vi.fn() }, post: { findMany } },
    );

    expect(findMany).toHaveBeenCalledWith({ where: { author: { is: { id: 'u1' } } }, select: { id: true } });
    expect(preExisting).toEqual(new Map([['posts', new Set(['p1', 'p2'])]]));
  });

  it('snapshots nothing for a path that only names rows', async () => {
    const findMany = vi.fn();

    const preExisting = await snapshot(
      { where: { id: 'u1' }, data: { posts: { update: { where: { id: 'p1' }, data: { title: 'A' } } } } },
      { user: { findUnique: vi.fn(), findFirst: vi.fn() }, post: { findMany } },
    );

    expect(findMany).not.toHaveBeenCalled();
    expect(preExisting.size).toBe(0);
  });

  it('snapshots a deeper path under the parent rows the pre-fetch found', async () => {
    const results: NestedPreFetchResults = new Map();
    storePreFetchResult(results, 'posts', {
      before: { kind: 'captured', row: { id: 'p1', authorId: 'u1' } },
      identity: 'p1',
      name: { by: 'uniqueWhere', where: { id: 'p1' } },
    });
    const findMany = vi.fn(async () => [{ id: 'c1' }]);

    const preExisting = await snapshot(
      {
        where: { id: 'u1' },
        data: { posts: { update: { where: { id: 'p1' }, data: { comments: { create: { content: 'x' } } } } } },
      },
      { user: { findUnique: vi.fn(), findFirst: vi.fn() }, comment: { findMany } },
      results,
    );

    expect(findMany).toHaveBeenCalledWith({ where: { post: { is: { id: 'p1' } } }, select: { id: true } });
    expect(preExisting).toEqual(new Map([['posts.comments', new Set(['c1'])]]));
  });

  const updateWithCommentCreate = {
    where: { id: 'u1' },
    data: { posts: { update: { where: { id: 'p1' }, data: { comments: { create: { content: 'x' } } } } } },
  };

  it('snapshots a deeper path under the key of a parent row whose read failed', async () => {
    const results: NestedPreFetchResults = new Map();
    storeUnreadRows(results, 'posts', [{ id: 'p1' }], { type: 'primaryKey', fields: ['id'] });
    const findMany = vi.fn(async () => [{ id: 'c1' }]);

    const preExisting = await snapshot(
      updateWithCommentCreate,
      { user: { findUnique: vi.fn(), findFirst: vi.fn() }, comment: { findMany } },
      results,
    );

    expect(findMany).toHaveBeenCalledWith({ where: { post: { is: { id: 'p1' } } }, select: { id: true } });
    expect(preExisting).toEqual(new Map([['posts.comments', new Set(['c1'])]]));
  });

  it('rejects for a deeper path under a parent row that could not be read and is not known by its key', async () => {
    const results: NestedPreFetchResults = new Map();
    storeUnreadRows(results, 'posts', undefined, { type: 'primaryKey', fields: ['id'] });
    const findMany = vi.fn(async () => [{ id: 'c1' }]);

    await expect(
      snapshot(
        updateWithCommentCreate,
        { user: { findUnique: vi.fn(), findFirst: vi.fn() }, comment: { findMany } },
        results,
      ),
    ).rejects.toThrow('Cannot snapshot the rows at nested path "posts.comments"');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('snapshots a deeper path under the key the WHERE of a parent operation names when that parent was not pre-fetched', async () => {
    const findMany = vi.fn(async () => [{ id: 'c1' }]);

    const preExisting = await snapshot(
      updateWithCommentCreate,
      { user: { findUnique: vi.fn(), findFirst: vi.fn() }, comment: { findMany } },
      new Map(),
      () => false,
    );

    expect(findMany).toHaveBeenCalledWith({ where: { post: { is: { id: 'p1' } } }, select: { id: true } });
    expect(preExisting).toEqual(new Map([['posts.comments', new Set(['c1'])]]));
  });

  it('gives a path whose model has no client to read with no entry', async () => {
    const preExisting = await snapshot(
      { where: { id: 'u1' }, data: { posts: { create: { title: 'A' } } } },
      { user: { findUnique: vi.fn(), findFirst: vi.fn() }, post: {} },
    );

    expect(preExisting.size).toBe(0);
  });

  it('records an empty snapshot without a query for a deeper path whose parent the operation creates', async () => {
    const findMany = vi.fn();

    const preExisting = await snapshot(
      { where: { id: 'u1' }, data: { posts: { create: { title: 'A', comments: { create: { content: 'x' } } } } } },
      {
        user: { findUnique: vi.fn(), findFirst: vi.fn() },
        post: { findMany: vi.fn(async () => []) },
        comment: { findMany },
      },
    );

    expect(findMany).not.toHaveBeenCalled();
    expect(preExisting).toEqual(
      new Map([
        ['posts', new Set()],
        ['posts.comments', new Set()],
      ]),
    );
  });

  it('rejects with the error of a failed snapshot query', async () => {
    const error = new Error('connection reset');

    await expect(
      snapshot(
        { where: { id: 'u1' }, data: { posts: { create: { title: 'A' } } } },
        {
          user: { findUnique: vi.fn(), findFirst: vi.fn() },
          post: {
            findMany: vi.fn(async () => {
              throw error;
            }),
          },
        },
      ),
    ).rejects.toBe(error);
  });
});
