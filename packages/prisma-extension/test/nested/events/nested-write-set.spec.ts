/**
 * Tests for the nested write set: the nested operations an operation executes and, per to-many
 * path, the rows they name and whether they insert rows.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import type { NestedBatchTargets, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import { buildNestedWriteSets, detectResolvedNestedOperations } from '../../../src/nested/events/write-set.js';
import { createDataOf } from '../../../src/nested/inserted-row-keys.js';
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

/**
 * The write sets of `data`; with `generatedKeys`, as if the extension had generated the key of
 * every row the nested creates insert
 */
const writeSetsOf = (
  data: Record<string, unknown>,
  results: NestedPreFetchResults = new Map(),
  batchTargets: NestedBatchTargets = new Map(),
  generatedKeys = false,
) => {
  const operations = detectResolvedNestedOperations(schemaMetadata, 'User', { data }, undefined, results);
  const rowsWithGeneratedKeys = new Set<object>(
    generatedKeys ? operations.flatMap((operation) => createDataOf(operation).map((row) => row.data)) : [],
  );
  return {
    operations,
    writeSets: buildNestedWriteSets(schemaMetadata, operations, rowsWithGeneratedKeys, results, batchTargets),
  };
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
          locator: { by: 'rowKey', where: { id: 'p1' } },
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
      generatedKeys: new Set(),
      anyNewRowIsInserted: false,
      readsPreExisting: false,
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
  ])(
    'marks a path with a nested %s whose data gives no key as inserting rows the snapshot tells apart',
    (_keyword, data) => {
      expect(writeSetsOf(data).writeSets.get('posts')).toEqual({
        targets: [],
        generatedKeys: new Set(),
        anyNewRowIsInserted: true,
        readsPreExisting: true,
      });
    },
  );

  it.each([
    [
      'create',
      {
        posts: {
          create: [
            { id: 'p8', title: 'A' },
            { id: 'p9', title: 'B' },
          ],
        },
      },
    ],
    [
      'createMany',
      {
        posts: {
          createMany: {
            data: [
              { id: 'p8', title: 'A' },
              { id: 'p9', title: 'B' },
            ],
          },
        },
      },
    ],
  ])(
    'holds the keys the extension generated for the rows a nested %s inserts, and reads no row before the write',
    (_keyword, data) => {
      expect(writeSetsOf(data, new Map(), new Map(), true).writeSets.get('posts')).toEqual({
        targets: [],
        generatedKeys: new Set(['p8', 'p9']),
        anyNewRowIsInserted: false,
        readsPreExisting: false,
      });
    },
  );

  it('treats a key the caller gives as unknown, which the database may store otherwise or a later write may change, and reads the rows held before the write', () => {
    const data = { posts: { create: [{ id: 'p9', title: 'A' }] } };

    expect(writeSetsOf(data).writeSets.get('posts')).toEqual({
      targets: [],
      generatedKeys: new Set(),
      anyNewRowIsInserted: true,
      readsPreExisting: true,
    });
  });

  it.each([
    ['updateMany', { updateMany: { where: { title: 'A' }, data: { id: 'changed' } } }],
    ['update', { update: { where: { id: 'p1' }, data: { id: 'changed' } } }],
  ])(
    'reads the rows held before the write when an %s at the path writes a key field, which may change a generated key',
    (_keyword, write) => {
      const data = { posts: { create: { id: 'p9', title: 'A' }, ...write } };

      expect(writeSetsOf(data, new Map(), new Map(), true).writeSets.get('posts')).toMatchObject({
        generatedKeys: new Set(['p9']),
        anyNewRowIsInserted: true,
        readsPreExisting: true,
      });
    },
  );

  it('reads the rows held before the write for a createMany with skipDuplicates, which may skip a row whose key it gives', () => {
    const data = { posts: { createMany: { data: [{ id: 'p9', title: 'A' }], skipDuplicates: true } } };

    expect(writeSetsOf(data, new Map(), new Map(), true).writeSets.get('posts')).toEqual({
      targets: [],
      generatedKeys: new Set(['p9']),
      anyNewRowIsInserted: false,
      readsPreExisting: true,
    });
  });

  it.each(['upsert', 'connectOrCreate'] as const)(
    'holds the key generated for the create of a nested %s only when its target was not pre-fetched',
    (keyword) => {
      const data = { posts: { [keyword]: { where: { id: 'p1' }, create: { id: 'p1', title: 'A' }, update: {} } } };
      const generatedKeysWith = (before: Record<string, unknown> | null) =>
        writeSetsOf(data, preFetched([['posts', 'p1', before]]), new Map(), true).writeSets.get('posts')?.generatedKeys;

      expect(generatedKeysWith(p1)).toEqual(new Set());
      expect(generatedKeysWith(null)).toEqual(new Set(['p1']));
    },
  );

  it.each(['upsert', 'connectOrCreate'] as const)(
    'marks a path with a nested %s whose create gives no key as inserting rows only when a target was not pre-fetched',
    (keyword) => {
      const data = { posts: { [keyword]: { where: { id: 'p1' }, create: { title: 'A' }, update: {} } } };

      expect(writeSetsOf(data, preFetched([['posts', 'p1', p1]])).writeSets.get('posts')?.anyNewRowIsInserted).toBe(
        false,
      );
      expect(writeSetsOf(data, preFetched([['posts', 'p1', null]])).writeSets.get('posts')?.anyNewRowIsInserted).toBe(
        true,
      );
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
            locator: { by: 'rowKey', where: { id: 'p1' } },
            operation: operations[0],
            before: { kind: 'captured', row: p1 },
          },
          { locator: { by: 'rowKey', where: { id: 'p2' } }, operation: operations[0], before: { kind: 'none' } },
        ],
        generatedKeys: new Set(),
        anyNewRowIsInserted: false,
        readsPreExisting: false,
      });
    },
  );

  it('names no row for a batch keyword whose filter matched nothing', () => {
    expect(writeSetsOf({ posts: { deleteMany: { title: 'x' } } }).writeSets.get('posts')).toEqual({
      targets: [],
      generatedKeys: new Set(),
      anyNewRowIsInserted: false,
      readsPreExisting: false,
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
      generatedKeys: new Set(),
      anyNewRowIsInserted: true,
      readsPreExisting: true,
    });
  });

  it('names the rows a nested set links, so they are not read as inserted', () => {
    const { operations, writeSets } = writeSetsOf({ posts: { set: [{ id: 'p1' }], create: { title: 'A' } } });
    const set = operations.find((op) => op.operation === 'set');

    expect(writeSets.get('posts')).toEqual({
      targets: [
        { locator: { by: 'uniqueWhere', where: { id: 'p1' } }, operation: set, element: 0, before: { kind: 'none' } },
      ],
      generatedKeys: new Set(),
      anyNewRowIsInserted: true,
      readsPreExisting: true,
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
