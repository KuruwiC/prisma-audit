/**
 * Tests for mutation event collection: the top-level row and the nested records of a single
 * operation, and the rows of a batch operation.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type {
  NestedBatchKeyword,
  NestedBatchTargets,
  NestedPreFetchResults,
} from '../../src/grammar/nested-operations.js';
import type { PrismaBaseClient, PrismaHandle, PrismaNamespace } from '../../src/internal-types.js';
import { buildNestedWriteSets, detectResolvedNestedOperations } from '../../src/nested/events/write-set.js';
import type { PreExistingRows } from '../../src/nested/pre-fetch/pre-existing-rows.js';
import { markPathUnread, storePreFetchResult } from '../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { resolvedUpsertBranch } from '../../src/pipeline/before-state.js';
import {
  type BatchOperationOutcome,
  collectBatchOperationEvents,
  collectSingleOperationEvents,
  type SingleOperationOutcome,
} from '../../src/pipeline/collect-events.js';
import { NO_AUDITED_OMITTED_FIELDS } from '../../src/utils/audited-omitted-fields.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

/** Pre-fetch results in which `path` is unread: a read for rows it could not name failed */
const unreadAt = (path: string): NestedPreFetchResults => {
  const results: NestedPreFetchResults = new Map();
  markPathUnread(results, path);
  return results;
};

/** Stands for `Prisma.skip`: a field given it is left out of the query */
const skip = new (class Skip {})();
const Prisma: PrismaNamespace = { defineExtension: () => undefined, DbNull: null, skip };
const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true }),
    column('name'),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
  ]),
  model('Post', [
    column('id', { isId: true }),
    column('title'),
    column('authorId'),
    relation('author', 'User', 'UserPosts', { foreignKeyFields: ['authorId'], referencedFields: ['id'] }),
  ]),
  model('Legacy', [column('code')]),
  model('Device', [column('code', { isUnique: true, isRequired: true }), column('label', { isRequired: true })]),
  model('Reading', [column('at', { type: 'DateTime', isId: true, isRequired: true }), column('value')]),
  model(
    'Slot',
    [column('zone', { isRequired: true }), column('seat', { type: 'Int', isRequired: true }), column('note')],
    {
      uniqueIndexes: [{ name: null, fields: ['seat', 'zone'] }],
    },
  ),
  model('Badge', [
    column('ownerId', { isId: true, isRequired: true }),
    column('label', { isRequired: true }),
    relation('owner', 'User', 'UserBadge', { foreignKeyFields: ['ownerId'], referencedFields: ['id'] }),
  ]),
  model('Tag', [column('alias', { isUnique: true }), column('code', { isUnique: true, isRequired: true })]),
);

const deps = { Prisma, schemaMetadata, shouldFetchBefore: () => true, auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS };
const client: PrismaBaseClient = Object.create(null);

type SingleCase = Partial<
  Omit<SingleOperationOutcome, 'nestedOperations' | 'writeSets'> & {
    args: Record<string, unknown>;
    batchTargets: NestedBatchTargets;
  }
>;

/** An outcome whose resolved nested operations and write sets are resolved from `args`, as the executor does */
const single = (overrides: SingleCase = {}): SingleOperationOutcome => {
  const { args = { data: { name: 'Ann' } }, batchTargets = new Map(), ...outcome } = overrides;
  const base = {
    modelName: 'User',
    action: 'create' as const,
    result: { id: 'u1', name: 'Ann' },
    beforeState: { kind: 'none' } as BeforeState,
    nestedPreFetchResults: new Map(),
    preExistingRows: new Map() as PreExistingRows,
    linkReads: new Map(),
    client,
    ...outcome,
  };
  const nestedOperations = detectResolvedNestedOperations(
    schemaMetadata,
    base.modelName,
    args,
    resolvedUpsertBranch(base.action, base.beforeState),
    base.nestedPreFetchResults,
  );
  return {
    ...base,
    args,
    nestedOperations,
    writeSets: buildNestedWriteSets(schemaMetadata, nestedOperations, base.nestedPreFetchResults, batchTargets),
  };
};

describe('collectSingleOperationEvents', () => {
  it('collects the top-level row of a create, whose before state is never requested, as one event', async () => {
    const outcome = single();

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      {
        model: 'User',
        identity: 'u1',
        action: 'create',
        before: { kind: 'none' },
        after: outcome.result,
        origin: { path: '', op: 'create' },
      },
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'u1'],
  ])('rejects an operation result that is %s', async (_name, result) => {
    await expect(collectSingleOperationEvents(single({ result }), deps)).rejects.toThrow(
      '[@prisma-audit] Operation result must be an object',
    );
  });

  it('pairs an update with its before state', async () => {
    const before = { id: 'u1', name: 'Anne' };
    const outcome = single({
      action: 'update',
      args: { where: { id: 'u1' }, data: { name: 'Ann' } },
      beforeState: { kind: 'captured', row: before },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({
        action: 'update',
        before: { kind: 'captured', row: before },
        after: outcome.result,
        origin: { path: '', op: 'update' },
      }),
    ]);
  });

  it('carries the before state alone for a delete whose row was read before it', async () => {
    const before = { id: 'u1', name: 'Ann' };
    const outcome = single({
      action: 'delete',
      args: { where: { id: 'u1' } },
      beforeState: { kind: 'captured', row: before },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({ action: 'delete', before: { kind: 'captured', row: before }, after: undefined }),
    ]);
  });

  it('carries the row Prisma returned for a delete whose row was not read before it in after', async () => {
    const outcome = single({ action: 'delete', args: { where: { id: 'u1' } }, beforeState: { kind: 'none' } });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({ action: 'delete', before: { kind: 'none' }, after: outcome.result }),
    ]);
  });

  it.each([
    { beforeState: { kind: 'captured', row: { id: 'u1', name: 'Anne' } }, action: 'update' },
    { beforeState: { kind: 'none' }, action: 'create' },
  ] as const)(
    'resolves an upsert whose before state is $beforeState.kind to $action',
    async ({ beforeState, action }) => {
      const outcome = single({
        action: 'upsert',
        args: { where: { id: 'u1' }, create: { name: 'Ann' }, update: { name: 'Ann' } },
        beforeState,
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([
        expect.objectContaining({
          action,
          before: beforeState,
          origin: { path: '', op: 'upsert' },
        }),
      ]);
    },
  );

  it.each(['update', 'delete'] as const)(
    'records a top-level %s whose before-state fetch failed with an unavailable before state',
    async (action) => {
      const outcome = single({ action, args: { where: { id: 'u1' } }, beforeState: { kind: 'unavailable' } });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([expect.objectContaining({ action, before: { kind: 'unavailable' } })]);
    },
  );

  it('collects nothing for an upsert whose before-state fetch failed', async () => {
    const outcome = single({
      action: 'upsert',
      args: {
        where: { id: 'u1' },
        create: { name: 'Ann', posts: { create: { title: 'A' } } },
        update: { name: 'Ann' },
      },
      result: { id: 'u1', name: 'Ann', posts: [{ id: 'p1', title: 'A', authorId: 'u1' }] },
      beforeState: { kind: 'unavailable' },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([]);
  });

  it('gives a row that lacks its primary key an empty identity', async () => {
    const events = await collectSingleOperationEvents(single({ result: { name: 'Ann' } }), deps);

    expect(events[0]?.identity).toBe('');
  });

  it('gives a row of a model with no row key at all an empty identity', async () => {
    const events = await collectSingleOperationEvents(
      single({ modelName: 'Legacy', args: { data: { code: 'x' } }, result: { code: 'x' } }),
      deps,
    );

    expect(events[0]?.identity).toBe('');
  });

  it('names the row of a model without primary key by its unique field on a required column', async () => {
    const events = await collectSingleOperationEvents(
      single({ modelName: 'Device', args: { data: { code: 'd-1' } }, result: { code: 'd-1', label: 'one' } }),
      deps,
    );

    expect(events[0]?.identity).toBe('d-1');
  });

  it('names the row of a model without primary key by the JSON array of its composite unique key, in the constraint order', async () => {
    const events = await collectSingleOperationEvents(
      single({
        modelName: 'Slot',
        args: { data: { zone: 'a:b', seat: 7 } },
        result: { zone: 'a:b', seat: 7, note: null },
      }),
      deps,
    );

    expect(events[0]?.identity).toBe('[7,"a:b"]');
  });

  it('names the row of a model without primary key by its required unique field when a nullable one is declared first', async () => {
    const events = await collectSingleOperationEvents(
      single({ modelName: 'Tag', args: { data: { code: 't-1' } }, result: { alias: null, code: 't-1' } }),
      deps,
    );

    expect(events[0]?.identity).toBe('t-1');
  });

  it('gives a row of a model without primary key that lacks its unique field an empty identity', async () => {
    const events = await collectSingleOperationEvents(
      single({ modelName: 'Device', args: { data: { code: 'd-1' } }, result: { label: 'one' } }),
      deps,
    );

    expect(events[0]?.identity).toBe('');
  });

  describe('a top-level row returned without its key, which a client-level omit hides', () => {
    const before = { id: 'u1', name: 'Ann' };
    const captured: BeforeState = { kind: 'captured', row: before };

    it.each([
      { action: 'update' as const, args: { where: { id: 'u1' }, data: { name: 'Anne' } } },
      {
        action: 'upsert' as const,
        args: { where: { id: 'u1' }, create: { id: 'u1', name: 'Anne' }, update: { name: 'Anne' } },
      },
    ])(
      'takes the key of an $action from its before state into the row it records, leaving the result as it is',
      async ({ action, args }) => {
        const result = { name: 'Anne' };
        const outcome = single({ action, args, result, beforeState: captured });

        const events = await collectSingleOperationEvents(outcome, deps);

        expect(events).toEqual([
          expect.objectContaining({
            identity: 'u1',
            action: 'update',
            before: captured,
            after: { name: 'Anne', id: 'u1' },
          }),
        ]);
        expect(result).toEqual({ name: 'Anne' });
      },
    );

    it('names a delete by the key of its before state', async () => {
      const result = { name: 'Ann' };
      const outcome = single({ action: 'delete', args: { where: { id: 'u1' } }, result, beforeState: captured });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([
        expect.objectContaining({ identity: 'u1', action: 'delete', before: captured, after: undefined }),
      ]);
      expect(result).toEqual({ name: 'Ann' });
    });

    it.each([
      ['an update writes the key', 'update' as const, { where: { id: 'u1' }, data: { id: 'u9', name: 'Anne' } }],
      ['an update sets the key', 'update' as const, { where: { id: 'u1' }, data: { id: { set: 'u9' } } }],
      [
        'the update branch of an upsert writes the key',
        'upsert' as const,
        { where: { id: 'u1' }, create: { id: 'u1', name: 'Anne' }, update: { id: 'u9' } },
      ],
    ])('takes the key the write gives the row when %s', async (_label, action, args) => {
      const result = { name: 'Anne' };
      const outcome = single({ action, args, result, beforeState: captured });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([expect.objectContaining({ identity: 'u9', after: { name: 'Anne', id: 'u9' } })]);
      expect(result).toEqual({ name: 'Anne' });
    });

    it('takes a DateTime key the update gives as an ISO string as the Date Prisma reads back', async () => {
      const before = { at: new Date('2026-01-01T00:00:00.000Z'), value: 'v' };
      const outcome = single({
        modelName: 'Reading',
        action: 'update',
        args: { where: { at: before.at }, data: { at: '2026-01-02T03:04:05Z' } },
        result: { value: 'v' },
        beforeState: { kind: 'captured', row: before },
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([
        expect.objectContaining({
          identity: '2026-01-02T03:04:05.000Z',
          after: { value: 'v', at: new Date('2026-01-02T03:04:05.000Z') },
        }),
      ]);
    });

    it('takes the key of its before state when the update gives the key Prisma.skip', async () => {
      const outcome = single({
        action: 'update',
        args: { where: { id: 'u1' }, data: { id: skip, name: 'Anne' } },
        result: { name: 'Anne' },
        beforeState: captured,
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([expect.objectContaining({ identity: 'u1', after: { name: 'Anne', id: 'u1' } })]);
    });

    it('takes no key when the update changes the key by an operator', async () => {
      const outcome = single({
        action: 'update',
        args: { where: { id: 'u1' }, data: { id: { increment: 1 } } },
        result: { name: 'Ann' },
        beforeState: captured,
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([expect.objectContaining({ identity: '', after: { name: 'Ann' } })]);
    });

    it('takes no key from the before state when the update connects a relation whose foreign key is the key', async () => {
      const outcome = single({
        modelName: 'Badge',
        action: 'update',
        args: { where: { ownerId: 'u1' }, data: { owner: { connect: { id: 'u2' } } } },
        result: { label: 'gold' },
        beforeState: { kind: 'captured', row: { ownerId: 'u1', label: 'gold' } },
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events[0]).toEqual(expect.objectContaining({ identity: '', after: { label: 'gold' } }));
    });

    it.each([
      ['none', { kind: 'none' }],
      ['unavailable', { kind: 'unavailable' }],
    ] as const)('takes no key when the before state is %s', async (_label, beforeState) => {
      const outcome = single({
        action: 'update',
        args: { where: { id: 'u1' }, data: { name: 'Anne' } },
        result: { name: 'Anne' },
        beforeState,
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([expect.objectContaining({ identity: '', after: { name: 'Anne' } })]);
    });

    it('keeps the key the returned row holds', async () => {
      const outcome = single({
        action: 'update',
        args: { where: { id: 'u1' }, data: { name: 'Anne' } },
        result: { id: 'u1', name: 'Anne' },
        beforeState: { kind: 'captured', row: { id: 'u0', name: 'Ann' } },
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([expect.objectContaining({ identity: 'u1', after: outcome.result })]);
    });
  });

  it('collects the nested records after the top-level row, with their path and keyword', async () => {
    const posts = [
      { id: 'p1', title: 'A', authorId: 'u1' },
      { id: 'p2', title: 'B', authorId: 'u1' },
    ];
    const outcome = single({
      args: { data: { name: 'Ann', posts: { create: [{ title: 'A' }, { title: 'B' }] } } },
      result: { id: 'u1', name: 'Ann', posts },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({ model: 'User', identity: 'u1', origin: { path: '', op: 'create' } }),
      {
        model: 'Post',
        identity: 'p1',
        action: 'create',
        before: { kind: 'none' },
        after: posts[0],
        origin: { path: 'posts', op: 'create' },
      },
      {
        model: 'Post',
        identity: 'p2',
        action: 'create',
        before: { kind: 'none' },
        after: posts[1],
        origin: { path: 'posts', op: 'create' },
      },
    ]);
  });

  it('collects a nested delete without a before state from the primary key in the operation and the foreign key the parent row gives', async () => {
    const outcome = single({
      action: 'update',
      args: { where: { id: 'u1' }, data: { posts: { delete: { id: 'p9' } } } },
      result: { id: 'u1', name: 'Ann', posts: [] },
      beforeState: { kind: 'captured', row: { id: 'u1', name: 'Ann' } },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({ model: 'User', action: 'update' }),
      {
        model: 'Post',
        identity: 'p9',
        action: 'delete',
        before: { kind: 'none' },
        after: { id: 'p9', authorId: 'u1' },
        origin: { path: 'posts', op: 'delete' },
      },
    ]);
  });

  describe('rows of a to-many relation', () => {
    const p1 = { id: 'p1', title: 'A', authorId: 'u1' };
    const p2 = { id: 'p2', title: 'B', authorId: 'u1' };
    const p3 = { id: 'p3', title: 'C', authorId: 'u1' };
    const p1Before = { id: 'p1', title: 'A0', authorId: 'u1' };
    const p2Before = { id: 'p2', title: 'B0', authorId: 'u1' };
    const userBefore = { id: 'u1', name: 'Ann' };

    /** The primary keys a batch keyword at `posts` matched before the operation */
    const batchTargetsOf = (keyword: NestedBatchKeyword, ids: string[]): NestedBatchTargets =>
      new Map([['posts', new Map([[keyword, new Map(ids.map((id) => [id, { id }]))]])]]);

    const preFetched = (entries: [string, Record<string, unknown> | null][]): NestedPreFetchResults => {
      const results: NestedPreFetchResults = new Map();
      for (const [identity, before] of entries) {
        storePreFetchResult(results, 'posts', {
          before: before ? { kind: 'captured', row: before } : { kind: 'none' },
          identity,
          name: { by: 'uniqueWhere', where: { id: identity } },
        });
      }
      return results;
    };

    const postEvents = async (
      posts: Record<string, unknown>,
      rows: Record<string, unknown>[],
      overrides: SingleCase = {},
    ) => {
      const events = await collectSingleOperationEvents(
        single({
          action: 'update',
          args: { where: { id: 'u1' }, data: { posts } },
          result: { id: 'u1', name: 'Ann', posts: rows },
          beforeState: { kind: 'captured', row: userBefore },
          ...overrides,
        }),
        deps,
      );
      return events.filter((event) => event.model === 'Post');
    };

    it('attributes an update the row its WHERE names, with its before state, and not its siblings', async () => {
      const events = await postEvents({ update: { where: { id: 'p1' }, data: { title: 'A' } } }, [p1, p2], {
        nestedPreFetchResults: preFetched([['p1', p1Before]]),
      });

      expect(events).toEqual([
        {
          model: 'Post',
          identity: 'p1',
          action: 'update',
          before: { kind: 'captured', row: p1Before },
          after: p1,
          origin: { path: 'posts', op: 'update' },
        },
      ]);
    });

    it('attributes an update at a path whose pre-fetch failed the row with an unavailable before state', async () => {
      const events = await postEvents({ update: { where: { id: 'p1' }, data: { title: 'A' } } }, [p1, p2], {
        nestedPreFetchResults: unreadAt('posts'),
      });

      expect(events).toEqual([
        expect.objectContaining({ identity: 'p1', action: 'update', before: { kind: 'unavailable' } }),
      ]);
    });

    it('attributes a create the rows that did not exist under the parent before the operation', async () => {
      const events = await postEvents({ create: { title: 'C' } }, [p1, p2, p3], {
        preExistingRows: new Map([['posts', new Set(['p1', 'p2'])]]),
      });

      expect(events).toEqual([
        expect.objectContaining({ identity: 'p3', action: 'create', origin: { path: 'posts', op: 'create' } }),
      ]);
    });

    it('attributes an upsert whose target did not exist the inserted row as a create', async () => {
      const events = await postEvents(
        { upsert: { where: { id: 'missing' }, create: { title: 'C' }, update: {} } },
        [p1, p3],
        {
          nestedPreFetchResults: preFetched([['missing', null]]),
          preExistingRows: new Map([['posts', new Set(['p1'])]]),
        },
      );

      expect(events).toEqual([
        expect.objectContaining({ identity: 'p3', action: 'create', origin: { path: 'posts', op: 'upsert' } }),
      ]);
    });

    it.each([
      ['upsert', { upsert: { where: { id: 'p1' }, create: { title: 'C' }, update: { title: 'A' } } }],
      ['connectOrCreate', { connectOrCreate: { where: { id: 'p1' }, create: { title: 'C' } } }],
    ])('gives the row of a nested %s whose target could not be read no event', async (_keyword, posts) => {
      const events = await postEvents(posts, [p1, p2], {
        nestedPreFetchResults: unreadAt('posts'),
      });

      expect(events).toEqual([]);
    });

    it('attributes an upsert whose target existed that row as an update', async () => {
      const events = await postEvents(
        { upsert: { where: { id: 'p1' }, create: { title: 'C' }, update: {} } },
        [p1, p2],
        {
          nestedPreFetchResults: preFetched([['p1', p1Before]]),
        },
      );

      expect(events).toEqual([
        expect.objectContaining({ identity: 'p1', action: 'update', before: { kind: 'captured', row: p1Before } }),
      ]);
    });

    it('attributes an updateMany the rows its filter matched before the operation, with their before states', async () => {
      const events = await postEvents(
        {
          update: { where: { id: 'p1' }, data: { title: 'A' } },
          updateMany: { where: { title: 'B0' }, data: { title: 'B' } },
        },
        [p1, p2, p3],
        {
          nestedPreFetchResults: preFetched([
            ['p1', p1Before],
            ['p2', p2Before],
          ]),
          batchTargets: batchTargetsOf('updateMany', ['p2']),
        },
      );

      expect(events.map((event) => [event.identity, event.action, event.origin.op, event.before])).toEqual([
        ['p1', 'update', 'update', { kind: 'captured', row: p1Before }],
        ['p2', 'update', 'updateMany', { kind: 'captured', row: p2Before }],
      ]);
    });

    it('attributes an updateMany a matched row without a before state when none was read', async () => {
      const events = await postEvents({ updateMany: { where: { title: 'B0' }, data: { title: 'B' } } }, [p1, p2], {
        nestedPreFetchResults: preFetched([['p2', null]]),
        batchTargets: batchTargetsOf('updateMany', ['p2']),
      });

      expect(events).toEqual([
        {
          model: 'Post',
          identity: 'p2',
          action: 'update',
          before: { kind: 'none' },
          after: p2,
          origin: { path: 'posts', op: 'updateMany' },
        },
      ]);
    });

    it('collects a delete per row a deleteMany matched before the operation, from that read', async () => {
      const events = await postEvents({ deleteMany: { title: 'B0' } }, [p1], {
        nestedPreFetchResults: preFetched([
          ['p2', p2Before],
          ['p3', null],
        ]),
        batchTargets: batchTargetsOf('deleteMany', ['p2', 'p3']),
      });

      expect(events).toEqual([
        {
          model: 'Post',
          identity: 'p2',
          action: 'delete',
          before: { kind: 'captured', row: p2Before },
          after: undefined,
          origin: { path: 'posts', op: 'deleteMany' },
        },
        {
          model: 'Post',
          identity: 'p3',
          action: 'delete',
          before: { kind: 'none' },
          after: { id: 'p3', authorId: 'u1' },
          origin: { path: 'posts', op: 'deleteMany' },
        },
      ]);
    });

    it('gives a connected row no event and keeps it out of the inserted rows', async () => {
      const events = await postEvents({ connect: { id: 'p2' }, create: { title: 'C' } }, [p1, p2, p3], {
        preExistingRows: new Map([['posts', new Set(['p1'])]]),
      });

      expect(events).toEqual([expect.objectContaining({ identity: 'p3', action: 'create' })]);
    });

    it('attributes every inserted row to the first operation at the path that inserts rows', async () => {
      const events = await postEvents(
        { create: { title: 'C' }, upsert: { where: { id: 'missing' }, create: { title: 'D' }, update: {} } },
        [p1, p2, p3],
        {
          nestedPreFetchResults: preFetched([['missing', null]]),
          preExistingRows: new Map([['posts', new Set(['p1'])]]),
        },
      );

      expect(events.map((event) => [event.identity, event.origin.op])).toEqual([
        ['p2', 'create'],
        ['p3', 'create'],
      ]);
    });

    it('audits every returned row not named by an operation as created when the parent has no snapshot', async () => {
      const events = await postEvents({ create: { title: 'C' } }, [p1, p2]);

      expect(events.map((event) => [event.identity, event.action])).toEqual([
        ['p1', 'create'],
        ['p2', 'create'],
      ]);
    });

    describe('an updated row the returned rows leave out', () => {
      // The caller's own `include` or `select` on the relation keeps its filter, so a row an
      // operation updated can be missing from the rows returned at its path.

      const clientStoring = (stored: Record<string, unknown>[]) => {
        const byIds = async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
          stored.filter((row) => where.OR.some((filter) => filter.id === row.id));
        const post = { findMany: vi.fn(byIds) };
        const rereadClient: PrismaHandle = { post };
        return { rereadClient, post };
      };

      it('reads the row again by the primary key of its pre-fetched row and attributes it with its before state', async () => {
        const { rereadClient, post } = clientStoring([p1, p2]);

        const events = await postEvents({ update: { where: { id: 'p1' }, data: { title: 'A' } } }, [p2], {
          nestedPreFetchResults: preFetched([['p1', p1Before]]),
          client: rereadClient,
        });

        expect(post.findMany).toHaveBeenCalledTimes(1);
        expect(post.findMany).toHaveBeenCalledWith({ where: { OR: [{ id: 'p1' }] } });
        expect(events).toEqual([
          {
            model: 'Post',
            identity: 'p1',
            action: 'update',
            before: { kind: 'captured', row: p1Before },
            after: p1,
            origin: { path: 'posts', op: 'update' },
          },
        ]);
      });

      it('reads the row again by the WHERE of the update when no before state was read', async () => {
        const { rereadClient } = clientStoring([p1, p2]);

        const events = await postEvents({ update: { where: { id: 'p1' }, data: { title: 'A' } } }, [p2], {
          client: rereadClient,
        });

        expect(events).toEqual([
          expect.objectContaining({ identity: 'p1', action: 'update', before: { kind: 'none' }, after: p1 }),
        ]);
      });

      it('reads a row an updateMany matched again by its primary key', async () => {
        const { rereadClient, post } = clientStoring([p1, p2]);

        const events = await postEvents({ updateMany: { where: { title: 'B0' }, data: { title: 'B' } } }, [p1], {
          nestedPreFetchResults: preFetched([['p2', p2Before]]),
          batchTargets: batchTargetsOf('updateMany', ['p2']),
          client: rereadClient,
        });

        expect(post.findMany).toHaveBeenCalledWith({ where: { OR: [{ id: 'p2' }] } });
        expect(events).toEqual([
          expect.objectContaining({
            identity: 'p2',
            action: 'update',
            before: { kind: 'captured', row: p2Before },
            after: p2,
          }),
        ]);
      });

      it('does not read again a row the returned rows hold, nor the target of an upsert that inserted its row', async () => {
        const { rereadClient, post } = clientStoring([p1, p2, p3]);

        await postEvents(
          {
            update: { where: { id: 'p1' }, data: { title: 'A' } },
            upsert: { where: { id: 'missing' }, create: { title: 'C' }, update: {} },
          },
          [p1, p3],
          {
            nestedPreFetchResults: preFetched([
              ['p1', p1Before],
              ['missing', null],
            ]),
            preExistingRows: new Map([['posts', new Set(['p1', 'p2'])]]),
            client: rereadClient,
          },
        );

        expect(post.findMany).not.toHaveBeenCalled();
      });

      it('reads the row again that an upsert whose target existed updated', async () => {
        const { rereadClient, post } = clientStoring([p1, p2]);

        const events = await postEvents(
          { upsert: { where: { id: 'p1' }, create: { title: 'A' }, update: { title: 'A' } } },
          [p2],
          { nestedPreFetchResults: preFetched([['p1', p1Before]]), client: rereadClient },
        );

        expect(post.findMany).toHaveBeenCalledWith({ where: { OR: [{ id: 'p1' }] } });
        expect(events).toEqual([
          expect.objectContaining({
            identity: 'p1',
            action: 'update',
            before: { kind: 'captured', row: p1Before },
            after: p1,
            origin: { path: 'posts', op: 'upsert' },
          }),
        ]);
      });

      it("reads the rows a create inserted that the caller's restricted relation leaves out, once for the path", async () => {
        const stored = [p1, p3];
        const findMany = vi.fn(
          async ({ where, select }: { where: { OR: Record<string, unknown>[] }; select?: unknown }) =>
            select
              ? stored.map(({ id }) => ({ id }))
              : stored.filter((row) => where.OR.some((filter) => filter.id === row.id)),
        );

        const events = await postEvents({ create: { title: 'C' } }, [], {
          args: {
            where: { id: 'u1' },
            data: { posts: { create: { title: 'C' } } },
            include: { posts: { where: { title: 'none' } } },
          },
          preExistingRows: new Map([['posts', new Set(['p1'])]]),
          client: { post: { findMany } },
        });

        expect(findMany.mock.calls).toEqual([
          [{ where: { OR: [{ author: { is: { id: 'u1' } } }] }, select: { id: true } }],
          [{ where: { OR: [{ id: 'p3' }] } }],
        ]);
        expect(events).toEqual([expect.objectContaining({ identity: 'p3', action: 'create', after: p3 })]);
      });

      it('reads nothing again when the caller does not restrict the rows of the relation', async () => {
        const findMany = vi.fn();

        await postEvents({ create: { title: 'C' } }, [p3], {
          args: { where: { id: 'u1' }, data: { posts: { create: { title: 'C' } } }, include: { posts: true } },
          preExistingRows: new Map([['posts', new Set(['p1'])]]),
          client: { post: { findMany } },
        });

        expect(findMany).not.toHaveBeenCalled();
      });

      it('propagates a failed read', async () => {
        const readError = new Error('findMany failed');
        const rereadClient: PrismaHandle = {
          post: {
            findMany: vi.fn(async () => {
              throw readError;
            }),
          },
        };

        await expect(
          postEvents({ update: { where: { id: 'p1' }, data: { title: 'A' } } }, [p2], { client: rereadClient }),
        ).rejects.toBe(readError);
      });
    });
  });

  it('collects only the nested writes of the branch an upsert resolves to', async () => {
    const args = {
      where: { id: 'u1' },
      create: { name: 'Ann', posts: { create: { title: 'A' } } },
      update: { name: 'Ann' },
    };
    const result = { id: 'u1', name: 'Ann', posts: [{ id: 'p1', title: 'A', authorId: 'u1' }] };

    const created = await collectSingleOperationEvents(
      single({ action: 'upsert', args, result, beforeState: { kind: 'none' } }),
      deps,
    );
    const updated = await collectSingleOperationEvents(
      single({
        action: 'upsert',
        args,
        result,
        beforeState: { kind: 'captured', row: { id: 'u1', name: 'Anne' } },
      }),
      deps,
    );

    expect(created.map((e) => [e.model, e.action])).toEqual([
      ['User', 'create'],
      ['Post', 'create'],
    ]);
    expect(updated.map((e) => [e.model, e.action])).toEqual([['User', 'update']]);
  });
});

describe('collectSingleOperationEvents — a to-one relation', () => {
  it('records an update of the related row whose pre-fetch failed with an unavailable before state', async () => {
    const author = { id: 'u1', name: 'Anne' };
    const events = await collectSingleOperationEvents(
      single({
        modelName: 'Post',
        action: 'update',
        args: { where: { id: 'p1' }, data: { author: { update: { name: 'Anne' } } } },
        result: { id: 'p1', title: 'A', authorId: 'u1', author },
        beforeState: { kind: 'captured', row: { id: 'p1', title: 'A', authorId: 'u1' } },
        nestedPreFetchResults: unreadAt('author'),
      }),
      deps,
    );

    expect(events.filter((event) => event.model === 'User')).toEqual([
      expect.objectContaining({ identity: 'u1', action: 'update', before: { kind: 'unavailable' }, after: author }),
    ]);
  });
});

describe('collectSingleOperationEvents — a to-one relation below the rows a list create inserted', () => {
  const withoutRow = (identity: string): NestedPreFetchResults => {
    const results: NestedPreFetchResults = new Map();
    storePreFetchResult(results, 'posts.author', {
      before: { kind: 'none' },
      identity,
      name: { by: 'uniqueWhere', where: { id: identity } },
    });
    return results;
  };

  it('records each related row for the operation that wrote it, not for the first writer', async () => {
    const first = { id: 'ua', name: 'A' };
    const second = { id: 'ub', name: 'B' };
    const events = await collectSingleOperationEvents(
      single({
        action: 'update',
        args: {
          where: { id: 'u1' },
          data: {
            posts: {
              create: [
                { title: 'A', author: { connectOrCreate: { where: { id: 'ua' }, create: first } } },
                { title: 'B', author: { create: second } },
              ],
            },
          },
        },
        result: {
          id: 'u1',
          name: 'Ann',
          posts: [
            { id: 'p1', title: 'A', authorId: 'ua', author: first },
            { id: 'p2', title: 'B', authorId: 'ub', author: second },
          ],
        },
        beforeState: { kind: 'captured', row: { id: 'u1', name: 'Ann' } },
        nestedPreFetchResults: withoutRow('ua'),
      }),
      deps,
    );

    expect(events.filter((event) => event.origin.path === 'posts.author')).toEqual([
      expect.objectContaining({
        identity: 'ua',
        action: 'create',
        origin: { path: 'posts.author', op: 'connectOrCreate' },
      }),
      expect.objectContaining({ identity: 'ub', action: 'create', origin: { path: 'posts.author', op: 'create' } }),
    ]);
  });
});

describe('collectSingleOperationEvents — an upsert of a to-one relation', () => {
  it('gives the related row no event when its pre-fetch failed', async () => {
    const events = await collectSingleOperationEvents(
      single({
        modelName: 'Post',
        action: 'update',
        args: {
          where: { id: 'p1' },
          data: { author: { upsert: { create: { name: 'Anne' }, update: { name: 'Anne' } } } },
        },
        result: { id: 'p1', title: 'A', authorId: 'u1', author: { id: 'u1', name: 'Anne' } },
        beforeState: { kind: 'captured', row: { id: 'p1', title: 'A', authorId: 'u1' } },
        nestedPreFetchResults: unreadAt('author'),
      }),
      deps,
    );

    expect(events.filter((event) => event.model === 'User')).toEqual([]);
  });
});

describe('collectBatchOperationEvents', () => {
  const rows = [
    { id: 'p1', title: 'A', authorId: 'u1' },
    { id: 'p2', title: 'B', authorId: 'u1' },
  ];

  const batch = (overrides: Partial<BatchOperationOutcome> = {}): BatchOperationOutcome => ({
    modelName: 'Post',
    action: 'createMany',
    rows,
    ...overrides,
  });

  it('collects one create event per row of a createMany', () => {
    expect(collectBatchOperationEvents(batch(), schemaMetadata)).toEqual([
      {
        model: 'Post',
        identity: 'p1',
        action: 'create',
        before: { kind: 'none' },
        after: rows[0],
        origin: { path: '', op: 'createMany' },
      },
      {
        model: 'Post',
        identity: 'p2',
        action: 'create',
        before: { kind: 'none' },
        after: rows[1],
        origin: { path: '', op: 'createMany' },
      },
    ]);
  });

  it('pairs the rows of an updateMany with their before states', () => {
    const beforeStates = [{ id: 'p1', title: 'A0', authorId: 'u1' }, null];

    const events = collectBatchOperationEvents(batch({ action: 'updateMany', beforeStates }), schemaMetadata);

    expect(events).toEqual([
      expect.objectContaining({ action: 'update', before: { kind: 'captured', row: beforeStates[0] }, after: rows[0] }),
      expect.objectContaining({ action: 'update', before: { kind: 'none' }, after: rows[1] }),
    ]);
    expect(events.map((e) => e.origin)).toEqual([
      { path: '', op: 'updateMany' },
      { path: '', op: 'updateMany' },
    ]);
  });

  it('collects the before row of a deleteMany without an after row', () => {
    const events = collectBatchOperationEvents(batch({ action: 'deleteMany', beforeStates: rows }), schemaMetadata);

    expect(events).toEqual([
      {
        model: 'Post',
        identity: 'p1',
        action: 'delete',
        before: { kind: 'captured', row: rows[0] },
        after: undefined,
        origin: { path: '', op: 'deleteMany' },
      },
      {
        model: 'Post',
        identity: 'p2',
        action: 'delete',
        before: { kind: 'captured', row: rows[1] },
        after: undefined,
        origin: { path: '', op: 'deleteMany' },
      },
    ]);
  });

  it('names the rows of a model without primary key by their unique field on a required column', () => {
    const devices = [
      { code: 'd-1', label: 'one' },
      { code: 'd-2', label: 'two' },
    ];

    const events = collectBatchOperationEvents(
      batch({ modelName: 'Device', action: 'deleteMany', rows: devices, beforeStates: devices }),
      schemaMetadata,
    );

    expect(events.map((event) => event.identity)).toEqual(['d-1', 'd-2']);
  });

  it('collects the returned rows of a createManyAndReturn as create events carrying their own keyword', () => {
    const events = collectBatchOperationEvents(batch({ action: 'createManyAndReturn' }), schemaMetadata);

    expect(events).toEqual(
      rows.map((row) => ({
        model: 'Post',
        identity: row.id,
        action: 'create',
        before: { kind: 'none' },
        after: row,
        origin: { path: '', op: 'createManyAndReturn' },
      })),
    );
  });

  it('pairs the returned rows of an updateManyAndReturn with their before states as update events', () => {
    const beforeStates = [
      { id: 'p1', title: 'A0', authorId: 'u1' },
      { id: 'p2', title: 'B0', authorId: 'u1' },
    ];

    const events = collectBatchOperationEvents(batch({ action: 'updateManyAndReturn', beforeStates }), schemaMetadata);

    expect(events).toEqual(
      rows.map((row, index) => ({
        model: 'Post',
        identity: row.id,
        action: 'update',
        before: { kind: 'captured', row: beforeStates[index] },
        after: row,
        origin: { path: '', op: 'updateManyAndReturn' },
      })),
    );
  });

  it('rejects an action that is not a batch keyword', () => {
    expect(() => collectBatchOperationEvents(batch({ action: 'create' }), schemaMetadata)).toThrow(
      'Unknown batch action: create',
    );
  });
});
