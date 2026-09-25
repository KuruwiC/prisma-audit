/**
 * Tests for mutation event collection: the top-level row and the nested records of a single
 * operation, and the rows of a batch operation.
 */

import { describe, expect, it } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../../src/internal-types.js';
import { buildNestedWriteSets, detectExecutedNestedOperations } from '../../src/lifecycle/nested-handlers/write-set.js';
import type { PreExistingRows } from '../../src/lifecycle/pre-fetch/pre-existing-rows.js';
import { executedUpsertBranch } from '../../src/pipeline/before-state.js';
import {
  type BatchOperationOutcome,
  collectBatchOperationEvents,
  collectSingleOperationEvents,
  type SingleOperationOutcome,
} from '../../src/pipeline/collect-events.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'User',
          fields: [
            { name: 'id', kind: 'scalar', type: 'String', isId: true },
            { name: 'name', kind: 'scalar', type: 'String' },
            { name: 'posts', kind: 'object', type: 'Post', isList: true, relationName: 'UserPosts' },
          ],
        },
        {
          name: 'Post',
          fields: [
            { name: 'id', kind: 'scalar', type: 'String', isId: true },
            { name: 'title', kind: 'scalar', type: 'String' },
            { name: 'authorId', kind: 'scalar', type: 'String' },
            { name: 'author', kind: 'object', type: 'User', isList: false, relationName: 'UserPosts' },
          ],
        },
        {
          name: 'Legacy',
          fields: [{ name: 'code', kind: 'scalar', type: 'String' }],
        },
      ],
    },
  },
});

const deps = { schemaMetadata, getNestedOperationConfig: () => ({ fetchBeforeOperation: true }) };
const client: PrismaClientWithDynamicAccess = Object.create(null);

type SingleCase = Partial<
  Omit<SingleOperationOutcome, 'nestedOperations' | 'writeSets'> & { args: Record<string, unknown> }
>;

/** An outcome whose executed nested operations and write sets are resolved from `args`, as the executor does */
const single = (overrides: SingleCase = {}): SingleOperationOutcome => {
  const { args = { data: { name: 'Ann' } }, ...outcome } = overrides;
  const base = {
    modelName: 'User',
    action: 'create' as const,
    result: { id: 'u1', name: 'Ann' },
    beforeStateResult: { _tag: 'notRequested' as const },
    nestedPreFetchResults: new Map(),
    preExistingRows: new Map() as PreExistingRows,
    client,
    ...outcome,
  };
  const nestedOperations = detectExecutedNestedOperations(
    schemaMetadata,
    base.modelName,
    args,
    executedUpsertBranch(base.action, base.beforeStateResult),
    base.nestedPreFetchResults,
  );
  return { ...base, nestedOperations, writeSets: buildNestedWriteSets(nestedOperations, base.nestedPreFetchResults) };
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
        before: undefined,
        after: outcome.result,
        origin: { path: '', op: 'create' },
      },
    ]);
  });

  it('pairs an update with its before state', async () => {
    const before = { id: 'u1', name: 'Anne' };
    const outcome = single({
      action: 'update',
      args: { where: { id: 'u1' }, data: { name: 'Ann' } },
      beforeStateResult: { _tag: 'found', data: before },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({ action: 'update', before, after: outcome.result, origin: { path: '', op: 'update' } }),
    ]);
  });

  it('carries the row Prisma returned for a delete in after, next to the before state', async () => {
    const before = { id: 'u1', name: 'Ann' };
    const outcome = single({
      action: 'delete',
      args: { where: { id: 'u1' } },
      beforeStateResult: { _tag: 'found', data: before },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([expect.objectContaining({ action: 'delete', before, after: outcome.result })]);
  });

  it.each([
    { beforeStateResult: { _tag: 'found', data: { id: 'u1', name: 'Anne' } }, action: 'update' },
    { beforeStateResult: { _tag: 'notFound' }, action: 'create' },
  ] as const)(
    'resolves an upsert whose before state is $beforeStateResult._tag to $action',
    async ({ beforeStateResult, action }) => {
      const outcome = single({
        action: 'upsert',
        args: { where: { id: 'u1' }, create: { name: 'Ann' }, update: { name: 'Ann' } },
        beforeStateResult,
      });

      const events = await collectSingleOperationEvents(outcome, deps);

      expect(events).toEqual([
        expect.objectContaining({
          action,
          before: beforeStateResult._tag === 'found' ? beforeStateResult.data : undefined,
          origin: { path: '', op: 'upsert' },
        }),
      ]);
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
      beforeStateResult: { _tag: 'error', error: new Error('fetch failed') },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([]);
  });

  it('gives a row that lacks its primary key an empty identity', async () => {
    const events = await collectSingleOperationEvents(single({ result: { name: 'Ann' } }), deps);

    expect(events[0]?.identity).toBe('');
  });

  it('gives a row of a model without primary key an empty identity', async () => {
    const events = await collectSingleOperationEvents(
      single({ modelName: 'Legacy', args: { data: { code: 'x' } }, result: { code: 'x' } }),
      deps,
    );

    expect(events[0]?.identity).toBe('');
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
        before: undefined,
        after: posts[0],
        origin: { path: 'posts', op: 'create' },
      },
      {
        model: 'Post',
        identity: 'p2',
        action: 'create',
        before: undefined,
        after: posts[1],
        origin: { path: 'posts', op: 'create' },
      },
    ]);
  });

  it('collects a nested delete without a before state from the primary key in the operation', async () => {
    const outcome = single({
      action: 'update',
      args: { where: { id: 'u1' }, data: { posts: { delete: { id: 'p9' } } } },
      result: { id: 'u1', name: 'Ann', posts: [] },
      beforeStateResult: { _tag: 'found', data: { id: 'u1', name: 'Ann' } },
    });

    const events = await collectSingleOperationEvents(outcome, deps);

    expect(events).toEqual([
      expect.objectContaining({ model: 'User', action: 'update' }),
      {
        model: 'Post',
        identity: 'p9',
        action: 'delete',
        before: undefined,
        after: { id: 'p9' },
        origin: { path: 'posts', op: 'delete' },
      },
    ]);
  });

  describe('rows of a to-many relation', () => {
    const p1 = { id: 'p1', title: 'A', authorId: 'u1' };
    const p2 = { id: 'p2', title: 'B', authorId: 'u1' };
    const p3 = { id: 'p3', title: 'C', authorId: 'u1' };
    const p1Before = { id: 'p1', title: 'A0', authorId: 'u1' };
    const userBefore = { id: 'u1', name: 'Ann' };

    const preFetched = (entries: [string, Record<string, unknown> | null][]) => {
      const results = new Map();
      for (const [identity, before] of entries) {
        results.set('posts', (results.get('posts') ?? new Map()).set(identity, { before }));
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
          beforeStateResult: { _tag: 'found', data: userBefore },
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
          before: p1Before,
          after: p1,
          origin: { path: 'posts', op: 'update' },
        },
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

    it('attributes an upsert whose target existed that row as an update', async () => {
      const events = await postEvents(
        { upsert: { where: { id: 'p1' }, create: { title: 'C' }, update: {} } },
        [p1, p2],
        {
          nestedPreFetchResults: preFetched([['p1', p1Before]]),
        },
      );

      expect(events).toEqual([expect.objectContaining({ identity: 'p1', action: 'update', before: p1Before })]);
    });

    it('attributes an updateMany the rows no operation named', async () => {
      const events = await postEvents(
        { update: { where: { id: 'p1' }, data: { title: 'A' } }, updateMany: { where: {}, data: { title: 'X' } } },
        [p1, p2, p3],
      );

      expect(events.map((event) => [event.identity, event.action, event.origin.op])).toEqual([
        ['p1', 'update', 'update'],
        ['p2', 'update', 'updateMany'],
        ['p3', 'update', 'updateMany'],
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
  });

  it('collects only the nested writes of the branch an upsert executed', async () => {
    const args = {
      where: { id: 'u1' },
      create: { name: 'Ann', posts: { create: { title: 'A' } } },
      update: { name: 'Ann' },
    };
    const result = { id: 'u1', name: 'Ann', posts: [{ id: 'p1', title: 'A', authorId: 'u1' }] };

    const created = await collectSingleOperationEvents(
      single({ action: 'upsert', args, result, beforeStateResult: { _tag: 'notFound' } }),
      deps,
    );
    const updated = await collectSingleOperationEvents(
      single({
        action: 'upsert',
        args,
        result,
        beforeStateResult: { _tag: 'found', data: { id: 'u1', name: 'Anne' } },
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
        before: undefined,
        after: rows[0],
        origin: { path: '', op: 'createMany' },
      },
      {
        model: 'Post',
        identity: 'p2',
        action: 'create',
        before: undefined,
        after: rows[1],
        origin: { path: '', op: 'createMany' },
      },
    ]);
  });

  it('pairs the rows of an updateMany with their before states', () => {
    const beforeStates = [{ id: 'p1', title: 'A0', authorId: 'u1' }, null];

    const events = collectBatchOperationEvents(batch({ action: 'updateMany', beforeStates }), schemaMetadata);

    expect(events).toEqual([
      expect.objectContaining({ action: 'update', before: beforeStates[0], after: rows[0] }),
      expect.objectContaining({ action: 'update', before: undefined, after: rows[1] }),
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
        before: rows[0],
        after: undefined,
        origin: { path: '', op: 'deleteMany' },
      },
      {
        model: 'Post',
        identity: 'p2',
        action: 'delete',
        before: rows[1],
        after: undefined,
        origin: { path: '', op: 'deleteMany' },
      },
    ]);
  });

  it('rejects an action that is not a batch keyword', () => {
    expect(() => collectBatchOperationEvents(batch({ action: 'create' }), schemaMetadata)).toThrow(
      'Unknown batch action: create',
    );
  });
});
