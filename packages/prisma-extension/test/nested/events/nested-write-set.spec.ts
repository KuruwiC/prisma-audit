/**
 * Tests for the nested write set: the nested operations an operation executes and, per to-many
 * path, the rows they name and whether they insert rows.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import type { NestedBatchTargets, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import { buildNestedWriteSets, detectResolvedNestedOperations } from '../../../src/nested/events/write-set.js';
import { markPathUnread, storePreFetchResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';
import { column, model, relation, schemaMetadataOf } from '../../support/audit-schema.js';

const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id'),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
    relation('profile', 'Profile', 'UserProfile'),
  ]),
  model('Post', [
    column('id', { isId: true }),
    column('title'),
    relation('comments', 'Comment', 'PostComments', { isList: true }),
  ]),
  model('Comment', [column('id'), column('content')]),
  model('Profile', [column('id'), column('bio'), relation('badges', 'Badge', 'ProfileBadges', { isList: true })]),
  model('Badge', [column('id'), column('label')]),
);

const p1 = { id: 'p1', title: 'First' };

const preFetched = (entries: [string, string, Record<string, unknown> | null][]): NestedPreFetchResults => {
  const results: NestedPreFetchResults = new Map();
  for (const [path, identity, before] of entries) {
    storePreFetchResult(results, path, {
      before: before ? { kind: 'captured', row: before } : { kind: 'none' },
      identity,
      name: { by: 'uniqueWhere', where: { id: identity } },
    });
  }
  return results;
};

const writeSetsOf = (
  data: Record<string, unknown>,
  results: NestedPreFetchResults = new Map(),
  batchTargets: NestedBatchTargets = new Map(),
) => {
  const operations = detectResolvedNestedOperations(schemaMetadata, 'User', { data }, undefined, results);
  return { operations, writeSets: buildNestedWriteSets(schemaMetadata, operations, results, batchTargets) };
};

describe('detectResolvedNestedOperations', () => {
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

describe('detectResolvedNestedOperations of a to-one upsert', () => {
  const args = {
    data: {
      profile: {
        upsert: {
          create: { bio: 'new', badges: { create: { label: 'from create' } } },
          update: { bio: 'updated', badges: { deleteMany: {} } },
        },
      },
    },
  };
  const operationsGiven = (results: NestedPreFetchResults) =>
    detectResolvedNestedOperations(schemaMetadata, 'User', args, undefined, results).map(
      (op) => `${op.path}:${op.operation}`,
    );
  const readUnderTopLevelRow = (before: BeforeState): NestedPreFetchResults => {
    const results: NestedPreFetchResults = new Map();
    storePreFetchResult(results, 'profile', {
      before,
      identity: 'pr1',
      name: { by: 'parentRow', parent: TOP_LEVEL_ROW },
    });
    return results;
  };

  it('takes the update branch when the related row of the top-level row was read', () => {
    expect(operationsGiven(readUnderTopLevelRow({ kind: 'captured', row: { id: 'pr1' } }))).toEqual([
      'profile:upsert',
      'profile.badges:deleteMany',
    ]);
  });

  it('takes the create branch when the top-level row has no related row', () => {
    expect(operationsGiven(readUnderTopLevelRow({ kind: 'none' }))).toEqual([
      'profile:upsert',
      'profile.badges:create',
    ]);
  });

  it('scans neither branch when the read of the related rows failed', () => {
    const results: NestedPreFetchResults = new Map();
    markPathUnread(results, 'profile');

    expect(operationsGiven(results)).toEqual(['profile:upsert']);
  });
});

describe('buildNestedWriteSets', () => {
  it('builds no write set for a to-one path', () => {
    const { writeSets } = writeSetsOf({ profile: { update: { bio: 'B' } } });

    expect(writeSets.size).toBe(0);
  });

  it('locates the rows of a nested update by the primary key of the pre-fetched row, else by their WHERE', () => {
    const results = preFetched([['posts', 'p1', p1]]);
    const { operations, writeSets } = writeSetsOf(
      {
        posts: {
          update: [
            { where: { id: 'p1', title: 'First' }, data: { title: 'A' } },
            { where: { id: 'p2' }, data: { title: 'B' } },
          ],
        },
      },
      results,
    );

    expect(writeSets.get('posts')).toEqual({
      targets: [
        {
          locator: { by: 'primaryKey', where: { id: 'p1' } },
          operation: operations[0],
          element: 0,
          before: { kind: 'captured', row: p1 },
        },
        {
          locator: { by: 'uniqueWhere', where: { id: 'p2' } },
          operation: operations[0],
          element: 1,
          before: { kind: 'none' },
        },
      ],
      createsPending: false,
    });
  });

  it('locates a row by its WHERE when the before state read holds no complete primary key', () => {
    const results: NestedPreFetchResults = new Map();
    storePreFetchResult(results, 'posts', {
      before: { kind: 'captured', row: { title: 'First' } },
      identity: UNRESOLVED_ENTITY_ID,
      name: { by: 'uniqueWhere', where: { title: 'First' } },
    });

    const { operations, writeSets } = writeSetsOf(
      { posts: { update: { where: { title: 'First' }, data: { title: 'A' } } } },
      results,
    );

    expect(writeSets.get('posts')?.targets).toEqual([
      {
        locator: { by: 'uniqueWhere', where: { title: 'First' } },
        operation: operations[0],
        element: 0,
        before: { kind: 'captured', row: { title: 'First' } },
      },
    ]);
  });

  it('locates a row by its WHERE when the model declares no primary key', () => {
    const results = preFetched([['posts.comments', 'c1', { id: 'c1', content: 'text' }]]);

    const { operations, writeSets } = writeSetsOf(
      { posts: { update: { where: { id: 'p1' }, data: { comments: { update: { where: { id: 'c1' }, data: {} } } } } } },
      results,
    );
    const commentUpdate = operations.find((op) => op.path === 'posts.comments');

    expect(writeSets.get('posts.comments')?.targets).toEqual([
      {
        locator: { by: 'uniqueWhere', where: { id: 'c1' } },
        operation: commentUpdate,
        element: 0,
        before: { kind: 'captured', row: { id: 'c1', content: 'text' } },
      },
    ]);
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
    'locates the rows a %s matched before the operation by their primary key, with the before state read',
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
          {
            locator: { by: 'primaryKey', where: { id: 'p1' } },
            operation: operations[0],
            before: { kind: 'captured', row: p1 },
          },
          { locator: { by: 'primaryKey', where: { id: 'p2' } }, operation: operations[0], before: { kind: 'none' } },
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
      targets: [
        {
          locator: { by: 'uniqueWhere', where: { id: 'p1' } },
          operation: connect,
          element: 0,
          before: { kind: 'none' },
        },
      ],
      createsPending: true,
    });
  });

  it('names the rows a nested set links, so they are not read as inserted', () => {
    const { operations, writeSets } = writeSetsOf({ posts: { set: [{ id: 'p1' }], create: { title: 'A' } } });
    const set = operations.find((op) => op.operation === 'set');

    expect(writeSets.get('posts')).toEqual({
      targets: [
        { locator: { by: 'uniqueWhere', where: { id: 'p1' } }, operation: set, element: 0, before: { kind: 'none' } },
      ],
      createsPending: true,
    });
  });

  it('keeps the targets of each operation at a path apart', () => {
    const { operations, writeSets } = writeSetsOf({
      posts: { update: { where: { id: 'p1' }, data: {} }, delete: { id: 'p2' } },
    });

    expect(writeSets.get('posts')?.targets.map((target) => [target.locator.where, target.operation.operation])).toEqual(
      [
        [{ id: 'p1' }, 'update'],
        [{ id: 'p2' }, 'delete'],
      ],
    );
    expect(writeSets.get('posts')?.targets.map((target) => target.operation)).toEqual(operations);
  });
});
