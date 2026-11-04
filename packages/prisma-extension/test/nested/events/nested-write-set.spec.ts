/**
 * Tests for the nested write set: the nested operations an operation executes and, per to-many
 * path, the rows they name and whether they insert rows.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import { Decimal } from '@prisma/client/runtime/client';
import { describe, expect, it } from 'vitest';
import type { NestedBatchTargets, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import {
  buildNestedWriteSets,
  detectResolvedNestedOperations,
  EMPTY_WRITE_SET,
  isInsertedAt,
} from '../../../src/nested/events/write-set.js';
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

/** Stands for the client's Prisma namespace: its `skip` and `Decimal` */
const prisma = { skip: new (class Skip {})(), Decimal };

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
    writeSets: buildNestedWriteSets(
      schemaMetadata,
      'User',
      operations,
      rowsWithGeneratedKeys,
      results,
      batchTargets,
      prisma,
    ),
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
      unidentifiedInserts: new Map(),
      insertCounts: new Map(),
      knownInserts: new Map(),
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

  it('locates a row by its WHERE when the model declares no row key', () => {
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
      const { operations, writeSets } = writeSetsOf(data);

      expect(writeSets.get('posts')).toEqual({
        targets: [],
        generatedKeys: new Set(),
        anyNewRowIsInserted: true,
        unidentifiedInserts: new Map(),
        insertCounts: new Map([[operations[0], 1]]),
        knownInserts: new Map(),
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
      const { operations, writeSets } = writeSetsOf(data, new Map(), new Map(), true);

      expect(writeSets.get('posts')).toEqual({
        targets: [],
        generatedKeys: new Set(['p8', 'p9']),
        anyNewRowIsInserted: false,
        unidentifiedInserts: new Map(),
        insertCounts: new Map([[operations[0], 2]]),
        knownInserts: new Map([
          ['p8', operations[0]],
          ['p9', operations[0]],
        ]),
        readsPreExisting: false,
      });
    },
  );

  it('treats a key the caller gives as unknown, which the database may store otherwise or a later write may change, and reads the rows held before the write', () => {
    const data = { posts: { create: [{ id: 'p9', title: 'A' }] } };
    const { operations, writeSets } = writeSetsOf(data);

    expect(writeSets.get('posts')).toEqual({
      targets: [],
      generatedKeys: new Set(),
      anyNewRowIsInserted: true,
      unidentifiedInserts: new Map(),
      insertCounts: new Map([[operations[0], 1]]),
      knownInserts: new Map([['p9', operations[0]]]),
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
    const { operations, writeSets } = writeSetsOf(data, new Map(), new Map(), true);

    expect(writeSets.get('posts')).toEqual({
      targets: [],
      generatedKeys: new Set(['p9']),
      anyNewRowIsInserted: false,
      unidentifiedInserts: new Map(),
      insertCounts: new Map([[operations[0], 1]]),
      knownInserts: new Map([['p9', operations[0]]]),
      readsPreExisting: true,
    });
  });

  it.each([
    [
      'a createMany with skipDuplicates, which may skip the row',
      { createMany: { data: [{ id: 'p9' }], skipDuplicates: true } },
    ],
    [
      'a create next to a write of a key field, which may give another row that key',
      { create: { id: 'p9' }, update: { where: { id: 'p1' }, data: { id: 'p2' } } },
    ],
    [
      'an upsert, whose update branch may run on a row another writer inserted',
      { upsert: { where: { id: 'p9' }, create: { id: 'p9' }, update: {} } },
    ],
  ])('holds no key the caller gives whole as the key of an inserted row for %s', (_case, posts) => {
    const { writeSets } = writeSetsOf({ posts }, preFetched([['posts', 'p9', null]]));

    expect(writeSets.get('posts')?.knownInserts).toEqual(new Map());
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
        unidentifiedInserts: new Map(),
        insertCounts: new Map(),
        knownInserts: new Map(),
        readsPreExisting: false,
      });
    },
  );

  it('names no row for a batch keyword whose filter matched nothing', () => {
    expect(writeSetsOf({ posts: { deleteMany: { title: 'x' } } }).writeSets.get('posts')).toEqual({
      targets: [],
      generatedKeys: new Set(),
      anyNewRowIsInserted: false,
      unidentifiedInserts: new Map(),
      insertCounts: new Map(),
      knownInserts: new Map(),
      readsPreExisting: false,
    });
  });

  it('names the rows a nested connect links, so they are not read as inserted', () => {
    const { operations, writeSets } = writeSetsOf({ posts: { connect: [{ id: 'p1' }], create: { title: 'A' } } });
    const connect = operations.find((op) => op.operation === 'connect');
    const create = operations.find((op) => op.operation === 'create');

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
      unidentifiedInserts: new Map(),
      insertCounts: new Map([[create, 1]]),
      knownInserts: new Map(),
      readsPreExisting: true,
    });
  });

  it('names the rows a nested set links, so they are not read as inserted', () => {
    const { operations, writeSets } = writeSetsOf({ posts: { set: [{ id: 'p1' }], create: { title: 'A' } } });
    const set = operations.find((op) => op.operation === 'set');
    const create = operations.find((op) => op.operation === 'create');

    expect(writeSets.get('posts')).toEqual({
      targets: [
        { locator: { by: 'uniqueWhere', where: { id: 'p1' } }, operation: set, element: 0, before: { kind: 'none' } },
      ],
      generatedKeys: new Set(),
      anyNewRowIsInserted: true,
      unidentifiedInserts: new Map(),
      insertCounts: new Map([[create, 1]]),
      knownInserts: new Map(),
      readsPreExisting: true,
    });
  });

  it('keeps the targets of each operation at a path apart', () => {
    const { operations, writeSets } = writeSetsOf({
      posts: { update: { where: { id: 'p1' }, data: {} }, delete: { id: 'p2' } },
    });

    expect(writeSets.get('posts')?.targets.map((target) => [target.locator, target.operation.operation])).toEqual([
      [{ by: 'uniqueWhere', where: { id: 'p1' } }, 'update'],
      [{ by: 'uniqueWhere', where: { id: 'p2' } }, 'delete'],
    ]);
    expect(writeSets.get('posts')?.targets.map((target) => target.operation)).toEqual(operations);
  });
});

describe('buildNestedWriteSets of an update that writes the row key', () => {
  const locatorsOf = (
    data: Record<string, unknown>,
    results: NestedPreFetchResults = new Map(),
    batchTargets: NestedBatchTargets = new Map(),
  ) =>
    writeSetsOf(data, results, batchTargets)
      .writeSets.get('posts')
      ?.targets.map((target) => target.locator);

  it.each([
    ['a value', 'p9'],
    ['{ set }', { set: 'p9' }],
  ])('locates the row a nested update gives a key as %s by the key the write gives it', (_label, id) => {
    expect(
      locatorsOf(
        { posts: { update: { where: { id: 'p1' }, data: { id, title: 'A' } } } },
        preFetched([['posts', 'p1', p1]]),
      ),
    ).toEqual([{ by: 'rowKey', where: { id: 'p9' } }]);
  });

  it('locates the row by the key the write gives it when its WHERE names the whole row key and no before state was read', () => {
    expect(locatorsOf({ posts: { update: { where: { id: 'p2' }, data: { id: 'p8' } } } })).toEqual([
      { by: 'rowKey', where: { id: 'p8' } },
    ]);
  });

  it('locates the row the update branch of a nested upsert gives a key by the key the write gives it', () => {
    expect(
      locatorsOf(
        { posts: { upsert: { where: { id: 'p1' }, create: { title: 'A' }, update: { id: 'p9' } } } },
        preFetched([['posts', 'p1', p1]]),
      ),
    ).toEqual([{ by: 'rowKey', where: { id: 'p9' } }]);
  });

  it('locates the rows a nested updateMany gives a key by the key the write gives them', () => {
    const batchTargets: NestedBatchTargets = new Map([
      ['posts', new Map([['updateMany', new Map([['p1', { id: 'p1' }]])]])],
    ]);

    expect(
      locatorsOf({ posts: { updateMany: { where: { title: 'First' }, data: { id: 'p9' } } } }, new Map(), batchTargets),
    ).toEqual([{ by: 'rowKey', where: { id: 'p9' } }]);
  });

  it('cannot locate the rows of a nested updateMany whose elements write the key, which of its rows each element wrote being unknown', () => {
    const batchTargets: NestedBatchTargets = new Map([
      ['posts', new Map([['updateMany', new Map([['p1', { id: 'p1' }]])]])],
    ]);

    expect(
      locatorsOf(
        {
          posts: {
            updateMany: [
              { where: { title: 'First' }, data: { id: 'p9' } },
              { where: { title: 'Second' }, data: { title: 'x' } },
            ],
          },
        },
        new Map(),
        batchTargets,
      ),
    ).toEqual([{ by: 'unknown' }]);
  });

  it('cannot locate the row a nested update gives a key it does not tell, by an operator', () => {
    expect(
      locatorsOf(
        { posts: { update: { where: { id: 'p1' }, data: { id: { increment: 1 } } } } },
        preFetched([['posts', 'p1', p1]]),
      ),
    ).toEqual([{ by: 'unknown' }]);
  });
});

describe('buildNestedWriteSets of targets the keys they have after the write cannot tell apart', () => {
  const p2 = { id: 'p2', title: 'Second' };
  const both = preFetched([
    ['posts', 'p1', p1],
    ['posts', 'p2', p2],
  ]);
  const locatorsOf = (data: Record<string, unknown>, results: NestedPreFetchResults = both) =>
    writeSetsOf(data, results)
      .writeSets.get('posts')
      ?.targets.map((target) => target.locator);

  it('cannot locate updates that name different rows and give them the same key', () => {
    expect(
      locatorsOf({
        posts: {
          update: [
            { where: { id: 'p1' }, data: { id: 'p3' } },
            { where: { id: 'p2' }, data: { id: 'p3' } },
          ],
        },
      }),
    ).toEqual([{ by: 'unknown' }, { by: 'unknown' }]);
  });

  it('cannot locate an update that names the key another update gives a row, nor that update', () => {
    expect(
      locatorsOf({
        posts: {
          update: [
            { where: { id: 'p2' }, data: { id: 'p3' } },
            { where: { id: 'p1' }, data: { id: 'p2' } },
          ],
        },
      }),
    ).toEqual([{ by: 'unknown' }, { by: 'unknown' }]);
  });

  it('locates updates that give their rows keys no other target names or gives', () => {
    expect(
      locatorsOf({
        posts: {
          update: [
            { where: { id: 'p1' }, data: { id: 'p8' } },
            { where: { id: 'p2' }, data: { id: 'p9' } },
          ],
        },
      }),
    ).toEqual([
      { by: 'rowKey', where: { id: 'p8' } },
      { by: 'rowKey', where: { id: 'p9' } },
    ]);
  });

  it('locates an update and a connect that name the same row', () => {
    expect(
      locatorsOf({ posts: { connect: { id: 'p1' }, update: { where: { id: 'p1' }, data: { id: 'p9' } } } }),
    ).not.toContainEqual({ by: 'unknown' });
  });
});

describe('buildNestedWriteSets of rows inserted next to a target it cannot locate', () => {
  const unlocated = { where: { id: 'p1' }, data: { id: { increment: 1 } } };

  it('does not infer the rows a create inserts without a key the extension generated as inserted, and counts them', () => {
    const { operations, writeSets } = writeSetsOf(
      { posts: { create: [{ title: 'A' }, { title: 'B' }], update: unlocated } },
      preFetched([['posts', 'p1', p1]]),
    );
    const create = operations.find((operation) => operation.operation === 'create');

    expect(writeSets.get('posts')).toMatchObject({
      anyNewRowIsInserted: false,
      unidentifiedInserts: new Map([[create, 2]]),
      readsPreExisting: true,
    });
  });

  it('still holds the keys the extension generated for the rows a create inserts', () => {
    const { writeSets } = writeSetsOf(
      { posts: { create: { id: 'n1', title: 'A' }, update: unlocated } },
      preFetched([['posts', 'p1', p1]]),
      new Map(),
      true,
    );

    expect(writeSets.get('posts')).toMatchObject({
      generatedKeys: new Set(['n1']),
      anyNewRowIsInserted: false,
      unidentifiedInserts: new Map(),
    });
  });
});

describe('isInsertedAt', () => {
  const insertsWithoutKey = { ...EMPTY_WRITE_SET, anyNewRowIsInserted: true };

  it('is a row the snapshot does not hold, by the key the row had before the write', () => {
    const inserted = isInsertedAt(insertsWithoutKey, new Set(['before']));

    expect(inserted('after', 'before')).toBe(false);
    expect(inserted('after')).toBe(true);
  });

  it('is only a row with a key the extension generated when every row inserted has one', () => {
    const inserted = isInsertedAt({ ...EMPTY_WRITE_SET, generatedKeys: new Set(['new']) }, undefined);

    expect(inserted('new')).toBe(true);
    expect(inserted('other')).toBe(false);
  });
});
