/**
 * Tests for the nested write set: the nested operations an operation executes and, per to-many
 * path, the rows they name and whether they insert rows.
 */

import { describe, expect, it } from 'vitest';
import type { NestedBatchTargets, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { buildNestedWriteSets, detectExecutedNestedOperations } from '../../../src/nested/events/write-set.js';
import { storePreFetchResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { createSchemaMetadataFromDMMF } from '../../../src/utils/schema-metadata.js';

const scalar = (name: string) => ({ name, kind: 'scalar', type: 'String', isList: false });
const relation = (name: string, type: string, isList: boolean) => ({ name, kind: 'object', type, isList });

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'User',
          fields: [scalar('id'), relation('posts', 'Post', true), relation('profile', 'Profile', false)],
        },
        { name: 'Post', fields: [scalar('id'), scalar('title'), relation('comments', 'Comment', true)] },
        { name: 'Comment', fields: [scalar('id'), scalar('content')] },
        { name: 'Profile', fields: [scalar('id'), scalar('bio')] },
      ],
    },
  },
} as Parameters<typeof createSchemaMetadataFromDMMF>[0]);

const p1 = { id: 'p1', title: 'First' };

const preFetched = (entries: [string, string, Record<string, unknown> | null][]): NestedPreFetchResults => {
  const results: NestedPreFetchResults = new Map();
  for (const [path, identity, before] of entries) {
    storePreFetchResult(results, path, identity, before);
  }
  return results;
};

const writeSetsOf = (
  data: Record<string, unknown>,
  results: NestedPreFetchResults = new Map(),
  batchTargets: NestedBatchTargets = new Map(),
) => {
  const operations = detectExecutedNestedOperations(schemaMetadata, 'User', { data }, undefined, results);
  return { operations, writeSets: buildNestedWriteSets(operations, results, batchTargets) };
};

describe('detectExecutedNestedOperations', () => {
  it('takes the update branch of a nested upsert whose target row was pre-fetched', () => {
    const data = {
      posts: {
        upsert: {
          where: { id: 'p1' },
          create: { title: 'A', comments: { create: { content: 'new' } } },
          update: { title: 'B', comments: { deleteMany: {} } },
        },
      },
    };

    const found = writeSetsOf(data, preFetched([['posts', 'p1', p1]])).operations;
    const missing = writeSetsOf(data, preFetched([['posts', 'p1', null]])).operations;

    expect(found.map((op) => `${op.path}:${op.operation}`)).toEqual(['posts:upsert', 'posts.comments:deleteMany']);
    expect(missing.map((op) => `${op.path}:${op.operation}`)).toEqual(['posts:upsert', 'posts.comments:create']);
  });
});

describe('buildNestedWriteSets', () => {
  it('builds no write set for a to-one path', () => {
    const { writeSets } = writeSetsOf({ profile: { update: { bio: 'B' } } });

    expect(writeSets.size).toBe(0);
  });

  it('names the rows of a nested update by their WHERE, with the pre-fetched before state', () => {
    const results = preFetched([['posts', 'p1', p1]]);
    const { operations, writeSets } = writeSetsOf(
      {
        posts: {
          update: [
            { where: { id: 'p1' }, data: { title: 'A' } },
            { where: { id: 'p2' }, data: { title: 'B' } },
          ],
        },
      },
      results,
    );

    expect(writeSets.get('posts')).toEqual({
      targets: [
        { where: { id: 'p1' }, operation: operations[0], before: p1 },
        { where: { id: 'p2' }, operation: operations[0], before: undefined },
      ],
      createsPending: false,
    });
  });

  it.each([
    ['create', { posts: { create: { title: 'A' } } }],
    ['createMany', { posts: { createMany: { data: [{ title: 'A' }] } } }],
  ])('marks a path with a nested %s as inserting rows', (_keyword, data) => {
    expect(writeSetsOf(data).writeSets.get('posts')).toEqual({ targets: [], createsPending: true });
  });

  it.each(['upsert', 'connectOrCreate'] as const)(
    'marks a path with a nested %s as inserting rows only when a target was not pre-fetched',
    (keyword) => {
      const data = { posts: { [keyword]: { where: { id: 'p1' }, create: { title: 'A' }, update: {} } } };

      expect(writeSetsOf(data, preFetched([['posts', 'p1', p1]])).writeSets.get('posts')?.createsPending).toBe(false);
      expect(writeSetsOf(data, preFetched([['posts', 'p1', null]])).writeSets.get('posts')?.createsPending).toBe(true);
    },
  );

  it.each([
    ['updateMany', { posts: { updateMany: { where: { title: 'x' }, data: { title: 'y' } } } }],
    ['deleteMany', { posts: { deleteMany: { title: 'x' } } }],
  ] as const)(
    'names the rows a %s matched before the operation by their primary key, with the before state read',
    (keyword, data) => {
      const results = preFetched([['posts', 'p1', p1]]);
      const batchTargets: NestedBatchTargets = new Map([
        [
          'posts',
          new Map([
            [
              keyword,
              new Map([
                ['p1', { id: 'p1' }],
                ['p2', { id: 'p2' }],
              ]),
            ],
          ]),
        ],
      ]);

      const { operations, writeSets } = writeSetsOf(data, results, batchTargets);

      expect(writeSets.get('posts')).toEqual({
        targets: [
          { where: { id: 'p1' }, operation: operations[0], before: p1 },
          { where: { id: 'p2' }, operation: operations[0], before: undefined },
        ],
        createsPending: false,
      });
    },
  );

  it('names no row for a batch keyword whose filter matched nothing', () => {
    expect(writeSetsOf({ posts: { deleteMany: { title: 'x' } } }).writeSets.get('posts')).toEqual({
      targets: [],
      createsPending: false,
    });
  });

  it('names the rows a nested connect links, so they are not read as inserted', () => {
    const { operations, writeSets } = writeSetsOf({ posts: { connect: [{ id: 'p1' }], create: { title: 'A' } } });
    const connect = operations.find((op) => op.operation === 'connect');

    expect(writeSets.get('posts')).toEqual({
      targets: [{ where: { id: 'p1' }, operation: connect, before: undefined }],
      createsPending: true,
    });
  });

  it('keeps the targets of each operation at a path apart', () => {
    const { operations, writeSets } = writeSetsOf({
      posts: { update: { where: { id: 'p1' }, data: {} }, delete: { id: 'p2' } },
    });

    expect(writeSets.get('posts')?.targets.map((target) => [target.where, target.operation.operation])).toEqual([
      [{ id: 'p1' }, 'update'],
      [{ id: 'p2' }, 'delete'],
    ]);
    expect(writeSets.get('posts')?.targets.map((target) => target.operation)).toEqual(operations);
  });
});
