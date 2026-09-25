import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAggregateConfig } from '../src/aggregate/config.js';
import {
  batchResolveIds,
  defineEntity,
  foreignKey,
  resetUnbatchedResolverWarnings,
  resolveId,
  to,
} from '../src/aggregate/helpers.js';
import type { AggregateMapping } from '../src/aggregate/types.js';
import type { MutationEvent } from '../src/domain/mutation-event.js';
import type { ProjectionEnrichmentMeta } from '../src/enrichment/types.js';
import { type ResolveConfig, resolve } from '../src/resolve/index.js';
import type { AuditContext } from '../src/types.js';

type Row = Record<string, unknown>;

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };
const handle = { name: 'db' };
const read = () => handle;

const event = (model: string, after: Row, overrides: Partial<MutationEvent> = {}): MutationEvent => ({
  model,
  identity: String(after.id ?? ''),
  action: 'create',
  after,
  origin: { path: '', op: 'create' },
  ...overrides,
});

const configOf = (mapping: AggregateMapping, actor?: ResolveConfig['actor']): ResolveConfig => {
  const service = createAggregateConfig(mapping);
  return { entity: service.getEntityConfig, rootEntity: service.getEntityConfigByType, actor };
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

      const resolved = await resolve([event('Unknown', { id: 'x-1' })], auditContext, config, read);

      expect(resolved).toEqual([]);
    });

    it('keeps the event fields and returns the resolved events in event order', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }), Comment: defineEntity({ type: 'Comment' }) });
      const events = [
        event('Post', { id: 'p1' }, { before: { id: 'p1', title: 'old' }, action: 'update' }),
        event('Comment', { id: 'c1' }, { origin: { path: 'comments', op: 'create' } }),
        event('Post', { id: 'p2' }),
      ];

      const resolved = await resolve(events, auditContext, config, read);

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
        origin: { path: '', op: 'delete' },
      };

      const resolved = await resolve([rowless, event('Post', { id: 'p2' })], auditContext, config, read);

      expect(resolved.map((e) => e.identity)).toEqual(['p2']);
    });

    it('hands the before row to the callbacks of an event without an after row', async () => {
      const idResolver = vi.fn(async (row: Row) => row.id as string);
      const config = configOf({ Post: defineEntity({ type: 'Post', idResolver }) });
      const before = { id: 'p1', title: 'deleted' };

      const resolved = await resolve(
        [{ model: 'Post', identity: 'p1', action: 'delete', before, origin: { path: '', op: 'deleteMany' } }],
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

      const resolved = await resolve(rowsOf('Post', 3), auditContext, config, read);

      expect(enricher).toHaveBeenCalledTimes(1);
      expect(enricher.mock.calls[0]?.slice(0, 2)).toEqual([auditContext.actor, handle]);
      expect(resolved.map((e) => e.actorContext)).toEqual(Array(3).fill({ role: 'admin', of: auditContext.actor }));
    });

    it('is null without an actor enricher', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post' }) });

      const resolved = await resolve(rowsOf('Post', 1), auditContext, config, read);

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
          self: false,
          aggregates: [to('User', foreignKey('authorId'))],
          context: { enricher: postEnricher },
        }),
        Comment: defineEntity({ type: 'Comment', context: { enricher: commentEnricher } }),
        User: defineEntity({ type: 'User' }),
      });
      const events = [
        event('Post', { id: 'p1', title: 'first', authorId: 'u1' }),
        event('Comment', { id: 'c1' }),
        event('Post', { id: 'p2', title: 'rootless', authorId: null }),
        event('Post', { id: 'p3', title: 'third', authorId: 'u2' }),
      ];

      const resolved = await resolve(events, auditContext, config, read);

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

      const resolved = await resolve(rowsOf('Post', 1), auditContext, config, read);

      expect(resolved[0]?.entityContext).toBeNull();
    });
  });

  describe('aggregate roots', () => {
    it('resolves the self root by default', async () => {
      const config = configOf({ User: defineEntity({ type: 'User' }) });

      const resolved = await resolve([event('User', { id: 'user-123', name: 'John' })], auditContext, config, read);

      expect(resolved[0]?.roots).toEqual([
        { aggregateCategory: 'model', aggregateType: 'User', aggregateId: 'user-123' },
      ]);
    });

    it('resolves the self root and the declared roots in declaration order', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
      });

      const resolved = await resolve(
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

      const resolved = await resolve([event('Post', { id: 'post-456', title: 'Test' })], auditContext, config, read);

      expect(resolved[0]?.roots).toEqual([
        { aggregateCategory: 'model', aggregateType: 'Post', aggregateId: 'post-456' },
      ]);
    });

    it('skips a to() root whose resolver throws', async () => {
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              resolveId(async () => {
                throw new Error('DB down');
              }),
            ),
          ],
        }),
      });

      const resolved = await resolve([event('Post', { id: 'post-456' })], auditContext, config, read);

      expect(resolved[0]?.roots.map((r) => r.aggregateType)).toEqual(['Post']);
    });

    it('resolves no self root when self is false', async () => {
      const config = configOf({
        PostTag: defineEntity({
          type: 'PostTag',
          self: false,
          aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
        }),
      });

      const resolved = await resolve(
        [event('PostTag', { id: 'pt-123', postId: 'post-456', tagId: 'tag-789' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.roots.map((r) => r.aggregateType)).toEqual(['Post', 'Tag']);
    });

    it('yields nothing for a row without any root', async () => {
      const config = configOf({
        PostTag: defineEntity({ type: 'PostTag', self: false, aggregates: [to('Post', foreignKey('postId'))] }),
      });

      const resolved = await resolve([event('PostTag', { id: 'pt-123', postId: null })], auditContext, config, read);

      expect(resolved).toEqual([]);
    });

    it('drops the rows without roots and keeps the others', async () => {
      const config = configOf({
        Post: defineEntity({ type: 'Post', self: false, aggregates: [to('User', foreignKey('authorId'))] }),
      });
      const events = [
        event('Post', { id: 'p1', authorId: 'u1' }),
        event('Post', { id: 'p2', authorId: null }),
        event('Post', { id: 'p3', authorId: 'u2' }),
      ];

      const resolved = await resolve(events, auditContext, config, read);

      expect(resolved.map((e) => e.identity)).toEqual(['p1', 'p3']);
    });

    describe('batchResolveIds', () => {
      it('calls the batch resolver once with all rows of the model', async () => {
        const batchFn = vi.fn(async (rows: { authorId?: string }[]) => rows.map((row) => row.authorId ?? null));
        const config = configOf({
          Post: defineEntity({ type: 'Post', aggregates: [to('User', batchResolveIds(batchFn))] }),
        });
        const events = rowsOf('Post', 10);

        const resolved = await resolve(events, auditContext, config, read);

        expect(batchFn).toHaveBeenCalledTimes(1);
        expect(batchFn).toHaveBeenCalledWith(
          events.map((e) => e.after),
          handle,
        );
        expect(resolved[9]?.roots.map((r) => r.aggregateId)).toEqual(['post-9', 'u9']);
      });

      it('skips the aggregate when the batch resolver throws', async () => {
        const config = configOf({
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to(
                'User',
                batchResolveIds(async () => {
                  throw new Error('DB down');
                }),
              ),
            ],
          }),
        });

        const resolved = await resolve(rowsOf('Post', 2), auditContext, config, read);

        expect(resolved.flatMap((e) => e.roots.map((r) => r.aggregateType))).toEqual(['Post', 'Post']);
      });

      it('skips the aggregate when the batch resolver returns the wrong number of ids', async () => {
        const config = configOf({
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to(
                'User',
                batchResolveIds(async () => ['u1']),
              ),
            ],
          }),
        });

        const resolved = await resolve(rowsOf('Post', 3), auditContext, config, read);

        expect(resolved.flatMap((e) => e.roots.map((r) => r.aggregateType))).toEqual(['Post', 'Post', 'Post']);
      });
    });
  });

  describe('N+1 warning for row-by-row resolveId() resolvers', () => {
    const postWithResolveId = () =>
      configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              resolveId(async (row: { authorId?: string }) => row.authorId ?? null),
            ),
          ],
        }),
      });

    it('warns when more rows than the threshold are resolved one by one', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await resolve(rowsOf('Post', 6), auditContext, postWithResolveId(), read);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Post → aggregate "User"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Consider using batchResolveIds()'));
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

    it('does not warn for a batchResolveIds() resolver', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to(
              'User',
              batchResolveIds(async (rows: { authorId?: string }[]) => rows.map((row) => row.authorId ?? null)),
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

      const resolved = await resolve([event('Post', { id: 'p1', authorId: 'u1' })], auditContext, config, read);

      expect(resolved[0]?.aggregateContexts).toEqual(
        new Map([
          ['Post:p1', null],
          ['User:u1', null],
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
          self: false,
          aggregates: [
            to('User', foreignKey('authorId'), {
              context: {
                enricher: async (rows) => rows.map((row) => ({ postTitle: row.title, shared: 'projection' })),
              },
            }),
          ],
        }),
      });

      const resolved = await resolve(
        [event('Post', { id: 'p1', authorId: 'u1', title: 'T1' })],
        auditContext,
        config,
        read,
      );

      expect(resolved[0]?.aggregateContexts.get('User:u1')).toEqual({
        userName: 'name-u1',
        shared: 'projection',
        postTitle: 'T1',
      });
    });

    it('calls the root-side enricher once per (category, type) with the unique aggregate ids', async () => {
      const rootEnricher = vi.fn(async (ids: string[]) => ids.map((id) => ({ userName: `name-${id}` })));
      const config = configOf({
        User: defineEntity({ type: 'User', aggregateContext: { enricher: rootEnricher } }),
        Post: defineEntity({ type: 'Post', self: false, aggregates: [to('User', foreignKey('authorId'))] }),
      });
      const events = [
        event('Post', { id: 'p1', authorId: 'u1' }),
        event('Post', { id: 'p2', authorId: 'u1' }),
        event('Post', { id: 'p3', authorId: 'u2' }),
      ];

      const resolved = await resolve(events, auditContext, config, read);

      expect(rootEnricher).toHaveBeenCalledTimes(1);
      expect(rootEnricher.mock.calls[0]?.slice(0, 2)).toEqual([['u1', 'u2'], handle]);
      expect(resolved.map((e) => e.aggregateContexts.get(`User:${e.after?.authorId}`))).toEqual([
        { userName: 'name-u1' },
        { userName: 'name-u1' },
        { userName: 'name-u2' },
      ]);
    });

    it('enriches the self projection through self.context with the rows and their ids', async () => {
      const selfEnricher = vi.fn(async (rows: Row[], _db: unknown, meta: ProjectionEnrichmentMeta) =>
        rows.map((_row, i) => ({ selfCtx: meta.aggregateIds[i] })),
      );
      const config = configOf({ Post: defineEntity({ type: 'Post', self: { context: { enricher: selfEnricher } } }) });

      const resolved = await resolve(
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
      expect(resolved.map((e) => e.aggregateContexts.get(`Post:${e.identity}`))).toEqual([
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
          self: false,
          aggregates: [
            to('User', foreignKey('userAId'), { context: { enricher: enricherA } }),
            to('User', foreignKey('userBId'), { context: { enricher: enricherB } }),
          ],
        }),
      });

      const resolved = await resolve(
        [event('Friendship', { id: 'f1', userAId: 'u1', userBId: 'u2' })],
        auditContext,
        config,
        read,
      );

      expect(enricherA).toHaveBeenCalledTimes(1);
      expect(enricherB).toHaveBeenCalledTimes(1);
      expect(enricherA.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u1'] });
      expect(enricherB.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u2'] });
      expect(resolved[0]?.aggregateContexts.get('User:u1')).toEqual({ side: 'A' });
      expect(resolved[0]?.aggregateContexts.get('User:u2')).toEqual({ side: 'B' });
    });
  });

  describe('entity id', () => {
    it('stores the normalized id from the entity id resolver', async () => {
      const config = configOf({ Post: defineEntity({ type: 'Post', idResolver: async (row) => row.id as string }) });

      const resolved = await resolve([event('Post', { id: 42 })], auditContext, config, read);

      expect(resolved[0]?.entityId).toBe('42');
    });

    it('yields nothing when the id resolver returns no id although a root resolved', async () => {
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          idResolver: async () => null,
          self: false,
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const resolved = await resolve([event('Post', { id: 'p1', authorId: 'u1' })], auditContext, config, read);

      expect(resolved).toEqual([]);
    });

    it('fails when the id resolver of a row with a root throws', async () => {
      const config = configOf({
        Post: defineEntity({
          type: 'Post',
          idResolver: async () => {
            throw new Error('resolver broken');
          },
          self: false,
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      await expect(resolve([event('Post', { id: 'p1', authorId: 'u1' })], auditContext, config, read)).rejects.toThrow(
        'resolver broken',
      );
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
              to('User', resolveId(record('u1')), { context: { enricher: record([{ projection: true }]) } }),
              to('Tag', batchResolveIds(record(['t1']))),
            ],
            context: { enricher: record([{ entity: true }]) },
          }),
        },
        { enricher: record({ actor: true }) },
      );

      await resolve([event('Post', { id: 'p1' })], auditContext, config, perCallRead);

      const handles = perCallRead.mock.results.map((result) => result.value);
      expect(received.length).toBeGreaterThanOrEqual(7);
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
          context: {
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
            context: {
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

      const resolved = await resolve(rowsOf('Post', 1), auditContext, config, read);

      expect(resolved[0]?.actorContext).toEqual({ role: 'unknown' });
      expect(resolved[0]?.entityContext).toEqual({ title: 'unknown' });
    });
  });
});
