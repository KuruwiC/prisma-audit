/**
 * Tests for the snapshot of the rows a to-many relation holds before a nested create.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedPreFetchResults } from '../src/grammar/nested-operations.js';
import type { DMMFField, PrismaClientWithDynamicAccess, PrismaNamespace } from '../src/internal-types.js';
import { buildNestedWriteSets, detectExecutedNestedOperations } from '../src/nested/events/write-set.js';
import { snapshotPreExistingRows } from '../src/nested/pre-fetch/pre-existing-rows.js';
import { storePreFetchResult } from '../src/nested/pre-fetch/pre-fetch-result-store.js';
import type { AuditErrorObserver } from '../src/types.js';
import { createSchemaMetadataFromDMMF } from '../src/utils/schema-metadata.js';

const scalar = (name: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'scalar',
  type: 'String',
  isList: false,
  ...extra,
});

const relation = (name: string, type: string, relationName: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'object',
  type,
  isList: false,
  relationName,
  relationFromFields: [],
  relationToFields: [],
  ...extra,
});

const Prisma: PrismaNamespace = {
  defineExtension: () => undefined,
  DbNull: null,
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'User',
          fields: [scalar('id', { isId: true }), relation('posts', 'Post', 'UserPosts', { isList: true })],
        },
        {
          name: 'Post',
          fields: [
            scalar('id', { isId: true }),
            scalar('authorId'),
            relation('author', 'User', 'UserPosts', { relationFromFields: ['authorId'], relationToFields: ['id'] }),
            relation('comments', 'Comment', 'PostComments', { isList: true }),
          ],
        },
        {
          name: 'Comment',
          fields: [
            scalar('id', { isId: true }),
            scalar('postId'),
            relation('post', 'Post', 'PostComments', { relationFromFields: ['postId'], relationToFields: ['id'] }),
          ],
        },
      ],
    },
  },
};

const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
const getNestedOperationConfig = () => ({ fetchBeforeOperation: true });

const clientWith = (delegates: Record<string, Record<string, unknown>>): PrismaClientWithDynamicAccess => ({
  $transaction: async () => {
    throw new Error('not used');
  },
  $extends: () => undefined,
  ...delegates,
});

const snapshot = (
  args: Record<string, unknown>,
  delegates: Record<string, Record<string, unknown>>,
  nestedPreFetchResults: NestedPreFetchResults = new Map(),
  onSnapshotFailure?: AuditErrorObserver,
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
      writeSets: buildNestedWriteSets(nestedOperations, nestedPreFetchResults, new Map()),
      nestedPreFetchResults,
    },
    { Prisma, schemaMetadata, getNestedOperationConfig, onSnapshotFailure },
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
    storePreFetchResult(results, 'posts', 'p1', { id: 'p1', authorId: 'u1' });
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

  it('reports a failed snapshot under pre-fetch and leaves the path without one', async () => {
    const error = new Error('connection reset');
    const onSnapshotFailure = vi.fn<AuditErrorObserver>(async () => {});

    const preExisting = await snapshot(
      { where: { id: 'u1' }, data: { posts: { create: { title: 'A' } } } },
      {
        user: { findUnique: vi.fn(), findFirst: vi.fn() },
        post: {
          findMany: vi.fn(async () => {
            throw error;
          }),
        },
      },
      new Map(),
      onSnapshotFailure,
    );

    expect(onSnapshotFailure).toHaveBeenCalledWith({
      phase: 'pre-fetch',
      modelName: 'Post',
      operation: 'create',
      params: { title: 'A' },
      error,
    });
    expect(preExisting.size).toBe(0);
  });
});
