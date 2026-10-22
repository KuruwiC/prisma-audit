import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntityConfigLookup } from '../src/aggregate/entity-config-lookup.js';
import {
  batchLookup,
  defineEntity,
  foreignKey,
  lookup,
  resetUnbatchedResolverWarnings,
  to,
} from '../src/aggregate/helpers.js';
import type { EntityMap } from '../src/aggregate/types.js';
import type { MutationEvent } from '../src/domain/mutation-event.js';
import type { ProjectionEnrichmentMeta } from '../src/enrichment/types.js';
import { type ResolveConfig, resolve } from '../src/resolve/index.js';
import type { AuditContext } from '../src/types.js';

const MISSING_AUTHOR_ID =
  'The row has no "authorId" column; if the client leaves it out of its default reads, list it in the ' +
  "entity's auditOmittedFields";

type Row = Record<string, unknown>;

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };
const handle = { name: 'db' };
const read = () => handle;

const event = (model: string, after: Row, overrides: Partial<MutationEvent> = {}): MutationEvent => ({
  model,
  identity: String(after.id ?? ''),
  action: 'create',
  before: { kind: 'none' },
  after,
  origin: { path: '', op: 'create' },
  ...overrides,
});

const configOf = (entities: EntityMap, actorContext?: ResolveConfig['actorContext']): ResolveConfig => {
  const entityConfigs = createEntityConfigLookup(entities);
  return { entity: entityConfigs.byModel, rootEntity: entityConfigs.byCategoryAndType, actorContext };
};

const rowsOf = (model: string, count: number): MutationEvent[] =>
  Array.from({ length: count }, (_, i) => event(model, { id: `${model.toLowerCase()}-${i}`, authorId: `u${i}` }));

describe('resolve', () => {
  beforeEach(() => {
    resetUnbatchedResolverWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('events and rows', () => {
    it('yields nothing for a model without entity configuration', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }) });

      const { resolved } = await resolve([event('Unknown', { id: 'x-1' })], auditContext, config, read);

      expect(resolved).toEqual([]);
    });

    it('keeps the event fields and returns the resolved events in event order', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }), Comment: defineEntity({ type: 'Comment' }) });
      const events = [
        event(
          'Post',
          { id: 'p1' },
          { before: { kind: 'captured', row: { id: 'p1', title: 'old' } }, action: 'update' },
        ),
        event('Comment', { id: 'c1' }, { origin: { path: 'comments', op: 'create' } }),
        event('Post', { id: 'p2' }),
      ];

      const { resolved } = await resolve(events, auditContext, config, read);

      expect(resolved.map((e) => e.identity)).toEqual(['p1', 'c1', 'p2']);
      for (const [i, resolvedEvent] of resolved.entries()) {
        expect(resolvedEvent).toMatchObject(events[i] as MutationEvent);
      }
    });

    it('skips an event that carries neither an after nor a before row', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }) });
      const rowless: MutationEvent = {
        model: 'Post',
        identity: 'p1',
        action: 'delete',
        before: { kind: 'none' },
        origin: { path: '', op: 'delete' },
      };

      const { resolved } = await resolve([rowless, event('Post', { id: 'p2' })], auditContext, config, read);

      expect(resolved.map((e) => e.identity)).toEqual(['p2']);
    });

    it('skips an event without an after row whose before state could not be read', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }) });
      const unreadable: MutationEvent = {
        model: 'Post',
        identity: 'p1',
        action: 'delete',
        before: { kind: 'unavailable' },
        origin: { path: '', op: 'delete' },
      };

      const { resolved, failures } = await resolve(
        [unreadable, event('Post', { id: 'p2' })],
        auditContext,
        config,
        read,
      );

      expect(resolved.map((e) => e.identity)).toEqual(['p2']);
      expect(failures).toEqual([]);
    });

    it('hands the before row to the callbacks of an event without an after row', async () => {
      const idResolver = vi.fn(async (row: Row) => row.id as string);
      const config = configOf({ Post: defineEntity({ type: 'Post', idResolver }) });
      const before = { id: 'p1', title: 'deleted' };

      const { resolved } = await resolve(
        [
          {
            model: 'Post',
            identity: 'p1',
            action: 'delete',
            before: { kind: 'captured', row: before },
            origin: { path: '', op: 'deleteMany' },
          },
        ],
        auditContext,
        config,
        read,
      );

      expect(idResolver).toHaveBeenCalledWith(before, handle);
      expect(resolved[0]?.entityId).toBe('p1');
    });
  });

  describe('actor context', () => {
    it('enriches the actor once per call with the audit context actor', async () => {
      const enricher = vi.fn(async (actor: unknown) => ({ role: 'admin', of: actor }));
      const config = configOf({ Post: defineEntity({ type: 'Post' }) }, { enricher });

      const { resolved } = await resolve(rowsOf('Post', 3), auditContext, config, read);

      expect(enricher).toHaveBeenCalledTimes(1);
      expect(enricher.mock.calls[0]?.slice(0, 2)).toEqual([auditContext.actor, handle]);
      expect(resolved.map((e) => e.actorContext)).toEqual(Array(3).fill({ role: 'admin', of: auditContext.actor }));
    });

    it('is null without an actor enricher', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }) });

      const { resolved } = await resolve(rowsOf('Post', 1), auditContext, config, read);

      expect(resolved[0]?.actorContext).toBeNull();
    });

    it('is enriched even when there is no event', async () => {
      const enricher = vi.fn(async () => ({ role: 'admin' }));
      const config = configOf({ Post: defineEntity({ type: 'Post' }) }, { enricher });

      await resolve([], auditContext, config, read);

      expect(enricher).toHaveBeenCalledTimes(1);
    });
  });

  describe('entity context', () => {
    it('enriches the entity contexts once per model with all of its rows, rootless rows included', async () => {
      const postEnricher = vi.fn(async (rows: Row[]) => rows.map((row) => ({ title: row.title })));
      const commentEnricher = vi.fn(async (rows: Row[]) => rows.map(() => ({ kind: 'comment' })));
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          selfAggregate: false,
          aggregates: [to('User', foreignKey('authorId'))],
          entityContext: { enricher: postEnricher },
        }),
        Comment: defineEntity({ type: 'Comment', entityContext: { enricher: commentEnricher } }),
        User: defineEntity({ type: 'User' }),
      });
      const events = [
        event('Post', { id: 'p1', title: 'first', authorId: 'u1' }),
        event('Comment', { id: 'c1' }),
        event('Post', { id: 'p2', title: 'rootless', authorId: null }),
        event('Post', { id: 'p3', title: 'third', authorId: 'u2' }),
      ];

      const { resolved } = await resolve(events, auditContext, config, read);

      expect(postEnricher).toHaveBeenCalledTimes(1);
      expect(postEnricher.mock.calls[0]?.slice(0, 2)).toEqual([
        [events[0]?.after, events[2]?.after, events[3]?.after],
        handle,
      ]);
      expect(commentEnricher.mock.calls[0]?.slice(0, 2)).toEqual([[events[1]?.after], handle]);
      expect(resolved.map((e) => [e.identity, e.entityContext])).toEqual([
        ['p1', { title: 'first' }],
        ['c1', { kind: 'comment' }],
        ['p3', { title: 'third' }],
      ]);
    });

    it('is null without an entity enricher', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }) });

      const { resolved } = await resolve(rowsOf('Post', 1), auditContext, config, read);

      expect(resolved[0]?.entityContext).toBeNull();
    });
  });

  describe('aggregate roots', () => {
    it('resolves the self root by default', async () => {
      const config = configOf({ User: defineEntity({ type: 'User' }) });

      const { resolved } = await resolve([event('User', { id: 'user-123', name: 'John' })], auditContext, config, read);

      expect(resolved[0]?.roots).toEqual([
        { aggregateCategory: 'model', aggregateType: 'User', aggregateId: 'user-123' },
      ]);
    });

    it('resolves the self root and the declared roots in declaration order', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
      });

      const { resolved } = await resolve(
        [event('Post', { id: 'post-456', authorId: 'user-123' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.roots).toEqual([
        { aggregateCategory: 'model', aggregateType: 'Post', aggregateId: 'post-456' },
        { aggregateCategory: 'model', aggregateType: 'User', aggregateId: 'user-123' },
      ]);
    });

    it('skips a to() root whose resolver returns no id', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
      });

      const { resolved } = await resolve(
        [event('Post', { id: 'post-456', title: 'Test' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.roots).toEqual([
        { aggregateCategory: 'model', aggregateType: 'Post', aggregateId: 'post-456' },
      ]);
    });

    it('reports a to() root whose resolver throws and keeps the other roots of the row', async () => {
      const error = new Error('DB down');
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              lookup(async () => {
                throw error;
              }),
            ),
          ],
        }),
      });
      const events = [event('Post', { id: 'post-456' })];

      const { resolved, failures } = await resolve(events, auditContext, config, read);

      expect(resolved[0]?.roots.map((r) => r.aggregateType)).toEqual(['Post']);
      expect(failures).toEqual([
        { event: events[0], resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' }, error },
      ]);
    });

    it('reports a to() root whose resolver returns an id that cannot be normalized and keeps the other roots of the row', async () => {
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              lookup(async () => Object.create(null) as string),
            ),
          ],
        }),
      });
      const events = [event('Post', { id: 'post-456' })];

      const { resolved, failures } = await resolve(events, auditContext, config, read);

      expect(resolved[0]?.roots.map((r) => r.aggregateType)).toEqual(['Post']);
      expect(failures).toEqual([
        {
          event: events[0],
          resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' },
          error: new Error('Cannot normalize ID of type: object'),
        },
      ]);
    });

    describe('a foreignKey root and its column', () => {
      const commentConfig = () =>
        configOf({
          Comment: defineEntity({
            type: 'Comment',
            aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
          }),
        });
      const userRoot = { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' };

      it('reports a written row that lacks the column, and keeps the roots of its other columns', async () => {
        const events = [event('Comment', { id: 'c1', postId: 'p1' })];

        const { resolved, failures } = await resolve(events, auditContext, commentConfig(), read);

        expect(resolved[0]?.roots.map((r) => [r.aggregateType, r.aggregateId])).toEqual([
          ['Comment', 'c1'],
          ['Post', 'p1'],
        ]);
        expect(failures).toEqual([{ event: events[0], resolver: userRoot, error: new Error(MISSING_AUTHOR_ID) }]);
      });

      it('reports a row read before a delete that lacks the column', async () => {
        const events = [
          event(
            'Comment',
            { id: 'c1', postId: 'p1' },
            {
              action: 'delete',
              before: { kind: 'captured', row: { id: 'c1', postId: 'p1' } },
            },
          ),
        ];

        const { failures } = await resolve(events, auditContext, commentConfig(), read);

        expect(failures.map((failure) => [failure.resolver, failure.error.message])).toEqual([
          [userRoot, MISSING_AUTHOR_ID],
        ]);
      });

      it('resolves no root and reports nothing for a column that holds null', async () => {
        const { resolved, failures } = await resolve(
          [event('Comment', { id: 'c1', postId: 'p1', authorId: null })],
          auditContext,
          commentConfig(),
          read,
        );

        expect(resolved[0]?.roots.map((r) => r.aggregateType)).toEqual(['Comment', 'Post']);
        expect(failures).toEqual([]);
      });

      it.each([
        ['not read', { kind: 'none' } as const],
        ['unavailable', { kind: 'unavailable' } as const],
      ])(
        'resolves no root and reports nothing for a column the row of a delete whose before state is %s lacks',
        async (_, before) => {
          const { resolved, failures } = await resolve(
            [event('Comment', { id: 'c1', postId: 'p1' }, { action: 'delete', before })],
            auditContext,
            commentConfig(),
            read,
          );

          expect(resolved[0]?.roots.map((r) => [r.aggregateType, r.aggregateId])).toEqual([
            ['Comment', 'c1'],
            ['Post', 'p1'],
          ]);
          expect(failures).toEqual([]);
        },
      );
    });

    it('resolves no self root when self is false', async () => {
      const config = configOf({
        PostTag: defineEntity({
          type: 'PostTag',
          selfAggregate: false,
          aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
        }),
      });

      const { resolved } = await resolve(
        [event('PostTag', { id: 'pt-123', postId: 'post-456', tagId: 'tag-789' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.roots.map((r) => r.aggregateType)).toEqual(['Post', 'Tag']);
    });

    it('yields nothing for a row without any root', async () => {
      const config = configOf({
        PostTag: defineEntity({
          type: 'PostTag',
          selfAggregate: false,
          aggregates: [to('Post', foreignKey('postId'))],
        }),
      });

      const { resolved } = await resolve(
        [event('PostTag', { id: 'pt-123', postId: null })],
        auditContext,
        config,
        read,
      );

      expect(resolved).toEqual([]);
    });

    it('drops the rows without roots and keeps the others', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', selfAggregate: false, aggregates: [to('User', foreignKey('authorId'))] }),
      });
      const events = [
        event('Post', { id: 'p1', authorId: 'u1' }),
        event('Post', { id: 'p2', authorId: null }),
        event('Post', { id: 'p3', authorId: 'u2' }),
      ];

      const { resolved } = await resolve(events, auditContext, config, read);

      expect(resolved.map((e) => e.identity)).toEqual(['p1', 'p3']);
    });

    describe('batchLookup', () => {
      it('calls the batch resolver once with all rows of the model', async () => {
        const batchFn = vi.fn(async (rows: { authorId?: string }[]) => rows.map((row) => row.authorId ?? null));
        const config = configOf({
          Post: defineEntity({ type: 'Post', aggregates: [to('User', batchLookup(batchFn))] }),
        });
        const events = rowsOf('Post', 10);

        const { resolved } = await resolve(events, auditContext, config, read);

        expect(batchFn).toHaveBeenCalledTimes(1);
        expect(batchFn).toHaveBeenCalledWith(
          events.map((e) => e.after),
          handle,
        );
        expect(resolved[9]?.roots.map((r) => r.aggregateId)).toEqual(['post-9', 'u9']);
      });

      it('skips the aggregate and reports every row of the call when the batch resolver throws', async () => {
        const error = new Error('DB down');
        const config = configOf({
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to(
                'User',
                batchLookup(async () => {
                  throw error;
                }),
              ),
            ],
          }),
        });
        const events = rowsOf('Post', 2);

        const { resolved, failures } = await resolve(events, auditContext, config, read);

        expect(resolved.flatMap((e) => e.roots.map((r) => r.aggregateType))).toEqual(['Post', 'Post']);
        const resolver = { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' };
        expect(failures).toEqual([
          { event: events[0], resolver, error },
          { event: events[1], resolver, error },
        ]);
      });

      it('reports only the rows whose id cannot be normalized and keeps the roots of the other rows', async () => {
        const config = configOf({
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to(
                'User',
                batchLookup(async () => ['u0', Object.create(null) as string]),
              ),
            ],
          }),
        });
        const events = rowsOf('Post', 2);

        const { resolved, failures } = await resolve(events, auditContext, config, read);

        expect(resolved.map((e) => e.roots.map((r) => r.aggregateType))).toEqual([['Post', 'User'], ['Post']]);
        expect(failures).toEqual([
          {
            event: events[1],
            resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' },
            error: new Error('Cannot normalize ID of type: object'),
          },
        ]);
      });

      it('skips the aggregate and reports every row of the call when the batch resolver returns the wrong number of ids', async () => {
        const config = configOf({
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to(
                'User',
                batchLookup(async () => ['u1']),
              ),
            ],
          }),
        });
        const events = rowsOf('Post', 3);

        const { resolved, failures } = await resolve(events, auditContext, config, read);

        expect(resolved.flatMap((e) => e.roots.map((r) => r.aggregateType))).toEqual(['Post', 'Post', 'Post']);
        expect(failures.map((failure) => [failure.event, failure.resolver.kind, failure.error.message])).toEqual(
          events.map((e) => [e, 'aggregate', 'The batch resolver of aggregate "User" returned 1 ids for 3 rows']),
        );
      });
    });
  });

  describe('roots of the row before an update or a delete', () => {
    const updated = (model: string, before: Row, after: Row): MutationEvent =>
      event(model, after, {
        action: 'update',
        before: { kind: 'captured', row: before },
        origin: { path: '', op: 'update' },
      });
    const root = (aggregateType: string, aggregateId: string) => ({
      aggregateCategory: 'model',
      aggregateType,
      aggregateId,
    });
    const postOfAuthor = (resolver = foreignKey('authorId')) =>
      configOf({ Post: defineEntity({ type: 'Post', aggregates: [to('User', resolver)] }) });

    it('adds the roots only the row before the update names after the roots of the row after it', async () => {
      const config = configOf({
        Comment: defineEntity({
          type: 'Comment',
          aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
        }),
      });

      const { resolved } = await resolve(
        [
          updated(
            'Comment',
            { id: 'c1', postId: 'p-old', authorId: 'u1' },
            { id: 'c1', postId: 'p-new', authorId: 'u1' },
          ),
        ],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.roots).toEqual([
        root('Comment', 'c1'),
        root('Post', 'p-new'),
        root('User', 'u1'),
        root('Post', 'p-old'),
      ]);
    });

    it('keeps one root when the rows before and after the update name the same aggregate', async () => {
      const { resolved } = await resolve(
        [updated('Post', { id: 'p1', authorId: 'u1', title: 'old' }, { id: 'p1', authorId: 'u1', title: 'new' })],
        auditContext,
        postOfAuthor(),
        read,
      );

      expect(resolved[0]?.roots).toEqual([root('Post', 'p1'), root('User', 'u1')]);
    });

    it('resolves only the old root of a row whose foreign key the update cleared', async () => {
      const { resolved } = await resolve(
        [updated('Post', { id: 'p1', authorId: 'u1' }, { id: 'p1', authorId: null })],
        auditContext,
        postOfAuthor(),
        read,
      );

      expect(resolved[0]?.roots).toEqual([root('Post', 'p1'), root('User', 'u1')]);
    });

    it('resolves only the new root of a row whose foreign key the update set', async () => {
      const { resolved } = await resolve(
        [updated('Post', { id: 'p1', authorId: null }, { id: 'p1', authorId: 'u1' })],
        auditContext,
        postOfAuthor(),
        read,
      );

      expect(resolved[0]?.roots).toEqual([root('Post', 'p1'), root('User', 'u1')]);
    });

    it('resolves a to() root from the one row of a create, a delete without an after row and an update without a captured before row', async () => {
      const resolver = vi.fn(async (row: Row) => row.authorId as string);
      const after = { id: 'p1', authorId: 'u-new' };
      const before = { id: 'p1', authorId: 'u-old' };
      const events: MutationEvent[] = [
        event('Post', after),
        event('Post', after, { action: 'update', before: { kind: 'none' } }),
        event('Post', after, { action: 'update', before: { kind: 'unavailable' } }),
        event('Post', before, { action: 'delete', before: { kind: 'captured', row: before }, after: undefined }),
      ];

      const { resolved } = await resolve(events, auditContext, postOfAuthor(lookup(resolver)), read);

      expect(resolver.mock.calls.map(([row]) => row)).toEqual([after, after, after, before]);
      expect(resolved.map((e) => e.roots.map((r) => r.aggregateId))).toEqual([
        ['p1', 'u-new'],
        ['p1', 'u-new'],
        ['p1', 'u-new'],
        ['p1', 'u-old'],
      ]);
    });

    it('adds the roots of the row before a delete that carries the row the write left it in', async () => {
      const resolver = vi.fn(async (row: Row) => row.authorId as string);
      const before = { id: 'p1', authorId: 'u-old' };
      const left = { id: 'p1', authorId: 'u-new' };
      const deleted = event('Post', left, {
        action: 'delete',
        before: { kind: 'captured', row: before },
        origin: { path: 'posts', op: 'delete' },
      });

      const { resolved } = await resolve([deleted], auditContext, postOfAuthor(lookup(resolver)), read);

      expect(resolver.mock.calls.map(([row]) => row)).toEqual([left, before]);
      expect(resolved[0]?.roots).toEqual([root('Post', 'p1'), root('User', 'u-new'), root('User', 'u-old')]);
    });

    it('identifies the row by the row after the update only', async () => {
      const idResolver = vi.fn(async (row: Row) => row.id as string);
      const config = configOf({
        Post: defineEntity({ type: 'Post', idResolver, aggregates: [to('User', foreignKey('authorId'))] }),
      });
      const after = { id: 'p1', authorId: 'u-new' };

      await resolve([updated('Post', { id: 'p1', authorId: 'u-old' }, after)], auditContext, config, read);

      expect(idResolver.mock.calls).toEqual([[after, handle]]);
    });

    it('runs a row-by-row resolver on the row before the update with the same handle', async () => {
      const resolver = vi.fn(async (row: Row) => row.authorId as string);
      const before = { id: 'p1', authorId: 'u-old' };
      const after = { id: 'p1', authorId: 'u-new' };

      const { resolved } = await resolve(
        [updated('Post', before, after)],
        auditContext,
        postOfAuthor(lookup(resolver)),
        read,
      );

      expect(resolver.mock.calls).toEqual([
        [after, handle],
        [before, handle],
      ]);
      expect(resolved[0]?.roots).toEqual([root('Post', 'p1'), root('User', 'u-new'), root('User', 'u-old')]);
    });

    it('drops only the old root when the resolver fails on the row before the update', async () => {
      const error = new Error('old author unreadable');
      const resolver = lookup(async (row: Row) => {
        if (row.authorId === 'u-old') {
          throw error;
        }
        return row.authorId as string;
      });
      const events = [updated('Post', { id: 'p1', authorId: 'u-old' }, { id: 'p1', authorId: 'u-new' })];

      const { resolved, failures } = await resolve(events, auditContext, postOfAuthor(resolver), read);

      expect(resolved[0]?.roots).toEqual([root('Post', 'p1'), root('User', 'u-new')]);
      expect(failures).toEqual([
        { event: events[0], resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' }, error },
      ]);
    });

    it('reports a resolver failing on both rows of an update once, with the error of the row after it', async () => {
      const resolver = lookup(async (row: Row) => {
        throw new Error(`unreadable ${String(row.authorId)}`);
      });
      const events = [updated('Post', { id: 'p1', authorId: 'u-old' }, { id: 'p1', authorId: 'u-new' })];

      const { resolved, failures } = await resolve(events, auditContext, postOfAuthor(resolver), read);

      expect(resolved[0]?.roots).toEqual([root('Post', 'p1')]);
      expect(failures.map((failure) => [failure.event, failure.error.message])).toEqual([
        [events[0], 'unreadable u-new'],
      ]);
    });

    describe('batchLookup', () => {
      const moves = [
        updated('Post', { id: 'p1', authorId: 'u1' }, { id: 'p1', authorId: 'u2' }),
        updated('Post', { id: 'p2', authorId: 'u3' }, { id: 'p2', authorId: 'u4' }),
      ];

      it('calls the batch resolver once with the rows after the updates followed by the rows before them', async () => {
        const batchFn = vi.fn(async (rows: { authorId?: string }[]) => rows.map((row) => row.authorId ?? null));

        const { resolved } = await resolve(moves, auditContext, postOfAuthor(batchLookup(batchFn)), read);

        expect(batchFn).toHaveBeenCalledTimes(1);
        expect(batchFn).toHaveBeenCalledWith(
          [
            { id: 'p1', authorId: 'u2' },
            { id: 'p2', authorId: 'u4' },
            { id: 'p1', authorId: 'u1' },
            { id: 'p2', authorId: 'u3' },
          ],
          handle,
        );
        expect(resolved.map((e) => e.roots.map((r) => r.aggregateId))).toEqual([
          ['p1', 'u2', 'u1'],
          ['p2', 'u4', 'u3'],
        ]);
      });

      it('reports each update once when the batch resolver throws', async () => {
        const error = new Error('DB down');
        const resolver = batchLookup(async () => {
          throw error;
        });

        const { failures } = await resolve(moves, auditContext, postOfAuthor(resolver), read);

        const failed = { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' };
        expect(failures).toEqual([
          { event: moves[0], resolver: failed, error },
          { event: moves[1], resolver: failed, error },
        ]);
      });

      it('reports each update once when the batch resolver returns the wrong number of ids', async () => {
        const { failures } = await resolve(moves, auditContext, postOfAuthor(batchLookup(async () => ['u1'])), read);

        expect(failures.map((failure) => [failure.event, failure.error.message])).toEqual(
          moves.map((e) => [e, 'The batch resolver of aggregate "User" returned 1 ids for 4 rows']),
        );
      });
    });

    it('enriches an old root of a projection with the row before the update', async () => {
      const enricher = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map((row) => ({ title: row.title })),
      );
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'), { aggregateContext: { enricher } })],
        }),
      });
      const before = { id: 'p1', authorId: 'u-old', title: 'old' };
      const after = { id: 'p1', authorId: 'u-new', title: 'new' };

      const { resolved } = await resolve([updated('Post', before, after)], auditContext, config, read);

      expect(enricher).toHaveBeenCalledTimes(1);
      expect(enricher.mock.calls[0]?.[0]).toEqual([after, before]);
      expect(enricher.mock.calls[0]?.[2]).toMatchObject({ aggregateIds: ['u-new', 'u-old'] });
      expect(resolved[0]?.aggregateContexts.get('model:User:u-new')).toEqual({ title: 'new' });
      expect(resolved[0]?.aggregateContexts.get('model:User:u-old')).toEqual({ title: 'old' });
    });

    it('enriches the old and the new root in one root-side call', async () => {
      const rootEnricher = vi.fn(async (ids: string[]) => ids.map((id) => ({ userName: `name-${id}` })));
      const config = configOf({
        User: defineEntity({ type: 'User', aggregateContext: { enricher: rootEnricher } }),
        Post: defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
      });

      const { resolved } = await resolve(
        [updated('Post', { id: 'p1', authorId: 'u-old' }, { id: 'p1', authorId: 'u-new' })],
        auditContext,
        config,
        read,
      );

      expect(rootEnricher).toHaveBeenCalledTimes(1);
      expect(rootEnricher.mock.calls[0]?.[0]).toEqual(['u-new', 'u-old']);
      expect(resolved[0]?.aggregateContexts.get('model:User:u-old')).toEqual({ userName: 'name-u-old' });
    });
  });

  describe('N+1 warning for row-by-row lookup() resolvers', () => {
    const postWithResolveId = () =>
      configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              lookup(async (row: { authorId?: string }) => row.authorId ?? null),
            ),
          ],
        }),
      });

    it('warns when more rows than the threshold are resolved one by one', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await resolve(rowsOf('Post', 6), auditContext, postWithResolveId(), read);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Post → aggregate "User"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Consider using batchLookup()'));
    });

    it('does not warn at or below the threshold', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await resolve(rowsOf('Post', 3), auditContext, postWithResolveId(), read);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns only once per aggregate type', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = postWithResolveId();

      await resolve(rowsOf('Post', 6), auditContext, config, read);
      await resolve(rowsOf('Post', 6), auditContext, config, read);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn for a batchLookup() resolver', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              batchLookup(async (rows: { authorId?: string }[]) => rows.map((row) => row.authorId ?? null)),
            ),
          ],
        }),
      });

      await resolve(rowsOf('Post', 10), auditContext, config, read);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('aggregate contexts', () => {
    it('keys the aggregate contexts by root type and id, null when nothing enriched them', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
        User: defineEntity({ type: 'User' }),
      });

      const { resolved } = await resolve([event('Post', { id: 'p1', authorId: 'u1' })], auditContext, config, read);

      expect(resolved[0]?.aggregateContexts).toEqual(
        new Map([
          ['model:Post:p1', null],
          ['model:User:u1', null],
        ]),
      );
    });

    it('merges root-side and projection-side contexts, projection keys winning', async () => {
      const config = configOf({
        User: defineEntity({
          type: 'User',
          aggregateContext: {
            enricher: async (ids: string[]) => ids.map((id) => ({ userName: `name-${id}`, shared: 'root' })),
          },
        }),
        Post: defineEntity({
          type: 'Post',
          selfAggregate: false,
          aggregates: [
            to('User', foreignKey('authorId'), {
              aggregateContext: {
                enricher: async (rows) => rows.map((row) => ({ postTitle: row.title, shared: 'projection' })),
              },
            }),
          ],
        }),
      });

      const { resolved } = await resolve(
        [event('Post', { id: 'p1', authorId: 'u1', title: 'T1' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.aggregateContexts.get('model:User:u1')).toEqual({
        userName: 'name-u1',
        shared: 'projection',
        postTitle: 'T1',
      });
    });

    it.each([
      ['a root context that is an array', ['root'], { projection: true }, { projection: true }],
      ['a root context that is a string', 'root', { projection: true }, { projection: true }],
      ['a projection context that is an array', { root: true }, ['projection'], ['projection']],
      ['a projection context that is a string', { root: true }, 'projection', 'projection'],
    ])('keeps the projection context unmerged when %s', async (_label, rootContext, projectionContext, expected) => {
      const config = configOf({
        User: defineEntity({ type: 'User', aggregateContext: { enricher: async (ids) => ids.map(() => rootContext) } }),
        Post: defineEntity({
          type: 'Post',
          selfAggregate: false,
          aggregates: [
            to('User', foreignKey('authorId'), {
              aggregateContext: { enricher: async (rows) => rows.map(() => projectionContext) },
            }),
          ],
        }),
      });

      const { resolved } = await resolve([event('Post', { id: 'p1', authorId: 'u1' })], auditContext, config, read);

      expect(resolved[0]?.aggregateContexts.get('model:User:u1')).toEqual(expected);
    });

    it('calls the root-side enricher once per (category, type) with the unique aggregate ids', async () => {
      const rootEnricher = vi.fn(async (ids: string[]) => ids.map((id) => ({ userName: `name-${id}` })));
      const config = configOf({
        User: defineEntity({ type: 'User', aggregateContext: { enricher: rootEnricher } }),
        Post: defineEntity({ type: 'Post', selfAggregate: false, aggregates: [to('User', foreignKey('authorId'))] }),
      });
      const events = [
        event('Post', { id: 'p1', authorId: 'u1' }),
        event('Post', { id: 'p2', authorId: 'u1' }),
        event('Post', { id: 'p3', authorId: 'u2' }),
      ];

      const { resolved } = await resolve(events, auditContext, config, read);

      expect(rootEnricher).toHaveBeenCalledTimes(1);
      expect(rootEnricher.mock.calls[0]?.slice(0, 2)).toEqual([['u1', 'u2'], handle]);
      expect(resolved.map((e) => e.aggregateContexts.get(`model:User:${e.after?.authorId}`))).toEqual([
        { userName: 'name-u1' },
        { userName: 'name-u1' },
        { userName: 'name-u2' },
      ]);
    });

    it('enriches the self aggregate through selfAggregate.aggregateContext with the rows and their ids', async () => {
      const selfEnricher = vi.fn(async (rows: Row[], _db: unknown, meta: ProjectionEnrichmentMeta) =>
        rows.map((_row, i) => ({ selfCtx: meta.aggregateIds[i] })),
      );
      const config = configOf({
        Post: defineEntity({ type: 'Post', selfAggregate: { aggregateContext: { enricher: selfEnricher } } }),
      });

      const { resolved } = await resolve(
        [event('Post', { id: 'p1' }), event('Post', { id: 'p2' })],
        auditContext,
        config,
        read,
      );

      expect(selfEnricher).toHaveBeenCalledTimes(1);
      expect(selfEnricher.mock.calls[0]?.[2]).toEqual({
        aggregateType: 'Post',
        aggregateCategory: 'model',
        aggregateIds: ['p1', 'p2'],
      });
      expect(resolved.map((e) => e.aggregateContexts.get(`model:Post:${e.identity}`))).toEqual([
        { selfCtx: 'p1' },
        { selfCtx: 'p2' },
      ]);
    });

    it('runs the own enricher of each to() projection when two target the same aggregate type', async () => {
      const enricherA = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map(() => ({ side: 'A' })),
      );
      const enricherB = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map(() => ({ side: 'B' })),
      );
      const config = configOf({
        Friendship: defineEntity({
          type: 'Friendship',
          selfAggregate: false,
          aggregates: [
            to('User', foreignKey('userAId'), { aggregateContext: { enricher: enricherA } }),
            to('User', foreignKey('userBId'), { aggregateContext: { enricher: enricherB } }),
          ],
        }),
      });

      const { resolved } = await resolve(
        [event('Friendship', { id: 'f1', userAId: 'u1', userBId: 'u2' })],
        auditContext,
        config,
        read,
      );

      expect(enricherA).toHaveBeenCalledTimes(1);
      expect(enricherB).toHaveBeenCalledTimes(1);
      expect(enricherA.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u1'] });
      expect(enricherB.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u2'] });
      expect(resolved[0]?.aggregateContexts.get('model:User:u1')).toEqual({ side: 'A' });
      expect(resolved[0]?.aggregateContexts.get('model:User:u2')).toEqual({ side: 'B' });
    });

    it('keeps the first to() declaration when two resolve the same aggregate id for a row', async () => {
      const enricherA = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map(() => ({ side: 'A' })),
      );
      const enricherB = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map(() => ({ side: 'B' })),
      );
      const config = configOf({
        Friendship: defineEntity({
          type: 'Friendship',
          selfAggregate: false,
          aggregates: [
            to('User', foreignKey('userAId'), { aggregateContext: { enricher: enricherA } }),
            to('User', foreignKey('userBId'), { aggregateContext: { enricher: enricherB } }),
          ],
        }),
      });

      const { resolved } = await resolve(
        [event('Friendship', { id: 'f1', userAId: 'u1', userBId: 'u1' })],
        auditContext,
        config,
        read,
      );

      expect(enricherA).toHaveBeenCalledTimes(1);
      expect(enricherA.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u1'] });
      expect(enricherB).not.toHaveBeenCalled();
      expect(resolved[0]?.aggregateContexts.get('model:User:u1')).toEqual({ side: 'A' });
      expect(resolved[0]?.roots).toEqual([{ aggregateCategory: 'model', aggregateType: 'User', aggregateId: 'u1' }]);
    });

    it('keeps one root when the self projection and a to() declaration resolve the same aggregate', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', aggregates: [to('Post', foreignKey('threadRootId'))] }),
      });

      const { resolved } = await resolve([event('Post', { id: 'p1', threadRootId: 'p1' })], auditContext, config, read);

      expect(resolved[0]?.roots).toEqual([{ aggregateCategory: 'model', aggregateType: 'Post', aggregateId: 'p1' }]);
    });

    it('keeps both roots when two to() declarations resolve the same id under different categories', async () => {
      const config = configOf({
        Friendship: defineEntity({
          type: 'Friendship',
          selfAggregate: false,
          aggregates: [
            to('User', foreignKey('userAId'), { category: 'member' }),
            to('User', foreignKey('userBId'), { category: 'guest' }),
          ],
        }),
      });

      const { resolved } = await resolve(
        [event('Friendship', { id: 'f1', userAId: 'u1', userBId: 'u1' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.roots).toEqual([
        { aggregateCategory: 'member', aggregateType: 'User', aggregateId: 'u1' },
        { aggregateCategory: 'guest', aggregateType: 'User', aggregateId: 'u1' },
      ]);
    });
    it('runs the enricher of each category and keys its context by the root when two to() declarations resolve the same id', async () => {
      const memberEnricher = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map(() => ({ side: 'member' })),
      );
      const guestEnricher = vi.fn(async (rows: Row[], _db: unknown, _meta: ProjectionEnrichmentMeta) =>
        rows.map(() => ({ side: 'guest' })),
      );
      const config = configOf({
        Friendship: defineEntity({
          type: 'Friendship',
          selfAggregate: false,
          aggregates: [
            to('User', foreignKey('userAId'), { category: 'member', aggregateContext: { enricher: memberEnricher } }),
            to('User', foreignKey('userBId'), { category: 'guest', aggregateContext: { enricher: guestEnricher } }),
          ],
        }),
      });

      const { resolved } = await resolve(
        [event('Friendship', { id: 'f1', userAId: 'u1', userBId: 'u1' })],
        auditContext,
        config,
        read,
      );

      expect(memberEnricher).toHaveBeenCalledTimes(1);
      expect(guestEnricher).toHaveBeenCalledTimes(1);
      expect(guestEnricher.mock.calls[0]?.[2]).toMatchObject({ aggregateCategory: 'guest', aggregateIds: ['u1'] });
      expect(resolved[0]?.aggregateContexts).toEqual(
        new Map([
          ['member:User:u1', { side: 'member' }],
          ['guest:User:u1', { side: 'guest' }],
        ]),
      );
    });
  });

  describe('entity id', () => {
    it('stores the normalized id from the entity id resolver', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post', idResolver: async (row) => row.id as string }) });

      const { resolved } = await resolve([event('Post', { id: 42 })], auditContext, config, read);

      expect(resolved[0]?.entityId).toBe('42');
    });

    it('yields nothing when the id resolver returns no id although a root resolved', async () => {
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          idResolver: async () => null,
          selfAggregate: false,
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const { resolved } = await resolve([event('Post', { id: 'p1', authorId: 'u1' })], auditContext, config, read);

      expect(resolved).toEqual([]);
    });

    it('calls the id resolver once per row and derives the self root from its id', async () => {
      const idResolver = vi.fn(async (row: Row) => row.id as string);
      const config = configOf({
        Post: defineEntity({ type: 'Post', idResolver, aggregates: [to('User', foreignKey('authorId'))] }),
      });
      const events = [event('Post', { id: 'p1', authorId: 'u1' }), event('Post', { id: 'p2', authorId: 'u2' })];

      const { resolved, failures } = await resolve(events, auditContext, config, read);

      expect(idResolver).toHaveBeenCalledTimes(2);
      expect(resolved.map((e) => [e.entityId, e.roots.map((r) => `${r.aggregateType}:${r.aggregateId}`)])).toEqual([
        ['p1', ['Post:p1', 'User:u1']],
        ['p2', ['Post:p2', 'User:u2']],
      ]);
      expect(failures).toEqual([]);
    });

    it('reports a throwing id resolver and yields nothing for its row, resolving the other rows', async () => {
      const error = new Error('resolver broken');
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          idResolver: async (row) => {
            if (row.id === 'p1') throw error;
            return row.id as string;
          },
          selfAggregate: false,
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });
      const events = [event('Post', { id: 'p1', authorId: 'u1' }), event('Post', { id: 'p2', authorId: 'u2' })];

      const { resolved, failures } = await resolve(events, auditContext, config, read);

      expect(resolved.map((e) => e.identity)).toEqual(['p2']);
      expect(failures).toEqual([{ event: events[0], resolver: { kind: 'entity' }, error }]);
    });

    it('reports a throwing id resolver of a row whose only root is the self root', async () => {
      const error = new Error('resolver broken');
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          idResolver: async () => {
            throw error;
          },
        }),
      });
      const events = [event('Post', { id: 'p1' })];

      const { resolved, failures } = await resolve(events, auditContext, config, read);

      expect(resolved).toEqual([]);
      expect(failures).toEqual([{ event: events[0], resolver: { kind: 'entity' }, error }]);
    });

    it('reports an id the id resolver returns that cannot be normalized', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post', idResolver: async (row) => row.key as string }) });
      const events = [event('Post', { id: 'p1', key: Object.create(null) })];

      const { resolved, failures } = await resolve(events, auditContext, config, read);

      expect(resolved).toEqual([]);
      expect(failures.map((failure) => [failure.event, failure.resolver, failure.error.message])).toEqual([
        [events[0], { kind: 'entity' }, 'Cannot normalize ID of type: object'],
      ]);
    });

    it('hands a row without an entity id to neither the entity enricher nor the to() resolvers', async () => {
      const enricher = vi.fn(async (rows: Row[]) => rows.map(() => null));
      const userResolver = vi.fn(async (row: Row) => row.authorId as string);
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          idResolver: async (row) => {
            if (row.id === 'p1') throw new Error('resolver broken');
            return row.id as string;
          },
          aggregates: [to('User', lookup(userResolver))],
          entityContext: { enricher },
        }),
      });
      const events = [event('Post', { id: 'p1', authorId: 'u1' }), event('Post', { id: 'p2', authorId: 'u2' })];

      await resolve(events, auditContext, config, read);

      expect(enricher.mock.calls.map((call) => call[0])).toEqual([[events[1]?.after]]);
      expect(userResolver.mock.calls.map((call) => call[0])).toEqual([events[1]?.after]);
    });
  });

  describe('database handle', () => {
    it('evaluates read at each callback call and hands every callback the handle it returned', async () => {
      const received: unknown[] = [];
      const record =
        <T>(value: T) =>
        async (_input: unknown, db: unknown) => {
          received.push(db);
          return value;
        };
      const perCallRead = vi.fn(() => ({ call: received.length }));
      const config = configOf(
        {
          User: defineEntity({ type: 'User', aggregateContext: { enricher: record([{ root: true }]) } }),
          Post: defineEntity({
            type: 'Post',
            idResolver: record('p1'),
            aggregates: [
              to('User', lookup(record('u1')), { aggregateContext: { enricher: record([{ projection: true }]) } }),
              to('Tag', batchLookup(record(['t1']))),
            ],
            entityContext: { enricher: record([{ entity: true }]) },
          }),
        },
        { enricher: record({ actor: true }) },
      );

      await resolve([event('Post', { id: 'p1' })], auditContext, config, perCallRead);

      const handles = perCallRead.mock.results.map((result) => result.value);
      expect(received).toHaveLength(7);
      expect(new Set(received).size).toBe(received.length);
      for (const db of received) {
        expect(handles).toContain(db);
      }
    });
  });

  describe('enricher failures', () => {
    it('fails the resolution when an enricher with the fail strategy throws', async () => {
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          entityContext: {
            enricher: async () => {
              throw new Error('enricher broken');
            },
          },
        }),
      });

      await expect(resolve(rowsOf('Post', 1), auditContext, config, read)).rejects.toThrow('enricher broken');
    });

    it('stores the fallback of an enricher with the log strategy', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = configOf(
        {
          Post: defineEntity({
            type: 'Post',
            entityContext: {
              enricher: async () => {
                throw new Error('enricher broken');
              },
              onError: 'log',
              fallback: [{ title: 'unknown' }],
            },
          }),
        },
        {
          enricher: async () => {
            throw new Error('actor broken');
          },
          onError: 'log',
          fallback: { role: 'unknown' },
        },
      );

      const { resolved } = await resolve(rowsOf('Post', 1), auditContext, config, read);

      expect(resolved[0]?.actorContext).toEqual({ role: 'unknown' });
      expect(resolved[0]?.entityContext).toEqual({ title: 'unknown' });
    });
  });
});
