import type { AuditActor, AuditIsolation, AuditObserver, AuditRecord, WriteMode } from '@kuruwic/db-audit-core';
import {
  AuditContextMissingError,
  AuditIncompleteError,
  AuditReentrantWriteError,
  AuditRollbackError,
  createAsyncLocalStorageProvider,
  defineEntities,
  defineEntity,
  foreignKey,
  to,
  UNHANDLED,
} from '@kuruwic/db-audit-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryAuditAdapter,
  identityOf,
  type MemoryAuditedHandle,
  type MemoryAuditOptions,
  type MemorySchema,
  memoryWriteExecutor,
} from '../src/index.js';

type ModelName = 'User' | 'Post';
type Db = MemoryAuditedHandle<ModelName>;
type UserRow = { id: string; name: string; email?: string };
type PostRow = { id: string; authorId: string; title: string };

const schema: MemorySchema<ModelName> = {
  User: { primaryKey: ['id'] },
  Post: { primaryKey: ['id'] },
};

const provider = createAsyncLocalStorageProvider();
const actor: AuditActor = { category: 'model', type: 'User', id: 'u1', name: 'Alice' };
const withContext = <T>(fn: () => Promise<T>): Promise<T> =>
  provider.runAsync({ actor, request: { path: '/posts' } }, fn);

const defineMapping = defineEntities<ModelName, Db>();

const baseMapping = defineMapping({
  User: defineEntity<UserRow, Db>({ type: 'User' }),
  Post: defineEntity<PostRow, Db>({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
});

const deferredPostMapping = defineMapping({
  User: defineEntity<UserRow, Db>({ type: 'User' }),
  Post: defineEntity<PostRow, Db>({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
    writeMode: 'deferred',
  }),
});

const createAdapter = (overrides: Partial<MemoryAuditOptions<ModelName>> = {}) =>
  createMemoryAuditAdapter<ModelName>({ schema, contextProvider: provider, entities: baseMapping, ...overrides });

const projection = ({ aggregateType, aggregateId, entityId }: AuditRecord) => ({
  aggregateType,
  aggregateId,
  entityId,
});

describe('audited writes', () => {
  it('create: one record with the created row as after and no before', async () => {
    const adapter = createAdapter();

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    const logs = adapter.store.auditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'create',
      before: null,
      after: { id: 'u1', name: 'Alice' },
      changes: null,
      actorCategory: 'model',
      actorType: 'User',
      actorId: 'u1',
      entityCategory: 'model',
      entityType: 'User',
      entityId: 'u1',
      aggregateCategory: 'model',
      aggregateType: 'User',
      aggregateId: 'u1',
      requestContext: { path: '/posts' },
    });
    expect(logs[0]?.createdAt).toBeInstanceOf(Date);
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('update: before, after and the diff of the changed fields; a change of excluded fields alone yields no record', async () => {
    const adapter = createAdapter({ diffExcludeFields: ['updatedAt'] });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice', updatedAt: 1 });
      await adapter.update('User', 'u1', { name: 'Bob', updatedAt: 2 });
      await adapter.update('User', 'u1', { updatedAt: 3 });
    });

    const logs = adapter.store.auditLogs();
    expect(logs.map((log) => log.action)).toEqual(['create', 'update']);
    expect(logs[1]).toMatchObject({
      before: { id: 'u1', name: 'Alice', updatedAt: 1 },
      after: { id: 'u1', name: 'Bob', updatedAt: 2 },
      beforeUnavailable: false,
    });
    expect(logs[1]?.changes).toEqual({ name: { old: 'Alice', new: 'Bob' } });
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Bob', updatedAt: 3 });
  });

  it('delete: the row before as before and no after', async () => {
    const adapter = createAdapter();

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.delete('User', 'u1');
    });

    expect(adapter.store.auditLogs()[1]).toMatchObject({
      action: 'delete',
      before: { id: 'u1', name: 'Alice' },
      after: null,
      changes: null,
    });
    expect(adapter.store.find('User', 'u1')).toBeUndefined();
  });

  it('create of a key that exists rejects, keeps the existing row and writes no record', async () => {
    const adapter = createAdapter();

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await expect(adapter.create('User', { id: 'u1', name: 'Bob' })).rejects.toThrow(
        '[audit-adapter-memory] User "u1" already exists',
      );
    });

    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.auditLogs().map((log) => log.action)).toEqual(['create']);
  });

  it.each([
    ['update', (adapter: ReturnType<typeof createAdapter>) => adapter.update('User', 'u1', { name: 'Bob' })],
    ['delete', (adapter: ReturnType<typeof createAdapter>) => adapter.delete('User', 'u1')],
  ])('%s of a missing row rejects, writes no row and no record', async (_action, write) => {
    const adapter = createAdapter();

    await expect(withContext(() => write(adapter))).rejects.toThrow('[audit-adapter-memory] User "u1" not found');

    expect(adapter.store.find('User', 'u1')).toBeUndefined();
    expect(adapter.store.auditLogs()).toEqual([]);
  });
});

describe('aggregate resolution and enrichment', () => {
  it('a Post projects onto itself and onto its User root', async () => {
    const adapter = createAdapter();

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });

    const postLogs = adapter.store.auditLogs().filter((log) => log.entityType === 'Post');
    expect(postLogs.map(projection).sort((a, b) => a.aggregateType.localeCompare(b.aggregateType))).toEqual([
      { aggregateType: 'Post', aggregateId: 'p1', entityId: 'p1' },
      { aggregateType: 'User', aggregateId: 'u1', entityId: 'p1' },
    ]);
  });

  it('an idResolver that throws, awaited: its row gets no record and is listed in resolverFailures, the write and the other rows are recorded', async () => {
    const resolverError = new Error('entity id resolver is broken');
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({
      write: { mode: 'awaited' },
      observer,
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({ type: 'User' }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          idResolver: async (post) => {
            if (post.title === 'broken') throw resolverError;
            return post.id;
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'broken' });
      await adapter.create('Post', { id: 'p2', authorId: 'u1', title: 'Hello' });
    });

    const failure = {
      phase: 'id-resolver-call',
      modelName: 'Post',
      operation: 'create',
      identity: 'p1',
      resolver: { kind: 'entity' },
      error: resolverError,
    };
    expect(adapter.resolverFailures).toEqual([failure]);
    expect(
      observer.mock.calls.map(([{ model, status, records, failures }]) => ({ model, status, records, failures })),
    ).toEqual([
      { model: 'User', status: 'complete', records: 1, failures: [] },
      { model: 'Post', status: 'incomplete', records: 0, failures: [failure] },
      { model: 'Post', status: 'complete', records: 1, failures: [] },
    ]);
    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'broken' });
    expect(adapter.store.auditLogs().map(({ entityType, entityId }) => `${entityType}:${entityId}`)).toEqual([
      'User:u1',
      'Post:p2',
    ]);
    expect(adapter.writeFailures).toEqual([]);
  });

  it('an idResolver that throws, atomic: the write fails with AuditIncompleteError and rolls back, the other rows are recorded', async () => {
    const resolverError = new Error('entity id resolver is broken');
    const adapter = createAdapter({
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({ type: 'User' }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          idResolver: async (post) => {
            if (post.title === 'broken') throw resolverError;
            return post.id;
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      const failed = adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'broken' });
      await expect(failed).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(failed).rejects.toMatchObject({
        modelName: 'Post',
        operation: 'create',
        failures: [{ phase: 'id-resolver-call', modelName: 'Post', error: resolverError }],
      });
      await adapter.create('Post', { id: 'p2', authorId: 'u1', title: 'Hello' });
    });

    expect(adapter.store.find('Post', 'p1')).toBeUndefined();
    expect(adapter.store.auditLogs().map(({ entityType, entityId }) => `${entityType}:${entityId}`)).toEqual([
      'User:u1',
      'Post:p2',
    ]);
  });

  it('awaited outside a transaction: the record is written on the store once the write has committed, before the call resolves', async () => {
    const committedWhenEnriched: boolean[] = [];
    const adapter: ReturnType<typeof createAdapter> = createAdapter({
      write: { mode: 'awaited' },
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users) => {
              committedWhenEnriched.push(users.every((user) => adapter.store.find('User', user.id) !== undefined));
              return users.map(() => null);
            },
          },
        }),
      }),
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);
    expect(committedWhenEnriched).toEqual([true]);
  });

  it('entity enricher: reads another table through the database handle into entityContext', async () => {
    const adapter = createAdapter({
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({ type: 'User' }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          entityContext: {
            enricher: async (posts, db) =>
              posts.map((post) => ({ authorName: db.find('User', post.authorId)?.name ?? null })),
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });

    const postLog = adapter.store.auditLogs().find((log) => log.entityType === 'Post');
    expect(postLog?.entityContext).toEqual({ authorName: 'Alice' });
  });

  it('actor enricher: reads the actor row through the database handle into actorContext', async () => {
    const adapter = createAdapter({
      actorContext: {
        enricher: async (currentActor, db) => ({ email: db.find('User', currentActor.id)?.email ?? null }),
      },
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice', email: 'alice@example.com' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });

    const postLog = adapter.store.auditLogs().find((log) => log.entityType === 'Post');
    expect(postLog?.actorContext).toEqual({ email: 'alice@example.com' });
  });

  it('aggregate context: the root-side and projection-side contexts merge with projection keys winning', async () => {
    const adapter = createAdapter({
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          aggregateContext: {
            enricher: async (ids, db) =>
              ids.map((id) => ({ source: 'root', owner: db.find('User', id)?.name ?? null })),
          },
        }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          aggregates: [
            to('User', foreignKey('authorId'), {
              aggregateContext: {
                enricher: async (posts, _db, meta) =>
                  posts.map((post, index) => ({
                    source: 'projection',
                    title: post.title,
                    aggregateId: meta.aggregateIds[index],
                  })),
              },
            }),
          ],
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });

    const postLogs = adapter.store.auditLogs().filter((log) => log.entityType === 'Post');
    const rootLog = postLogs.find((log) => log.aggregateType === 'User');
    const selfLog = postLogs.find((log) => log.aggregateType === 'Post');
    expect(rootLog?.aggregateContext).toEqual({
      source: 'projection',
      owner: 'Alice',
      title: 'Hello',
      aggregateId: 'u1',
    });
    expect(selfLog?.aggregateContext).toBeNull();
  });
});

describe('transaction membership', () => {
  it('read-your-writes: a callback inside a transaction reads the uncommitted row through the handle', async () => {
    const seen: unknown[] = [];
    const adapter = createAdapter({
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users, db) =>
              users.map((user) => {
                const name = db.find('User', user.id)?.name;
                seen.push(name);
                return { name };
              }),
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.transaction(async (db) => {
        await adapter.update('User', 'u1', { name: 'Bob' });
        expect(db.find('User', 'u1')?.name).toBe('Bob');
        expect(adapter.store.find('User', 'u1')?.name).toBe('Alice');
      });
    });

    expect(seen).toEqual(['Alice', 'Bob']);
    expect(adapter.store.find('User', 'u1')?.name).toBe('Bob');
    expect(adapter.store.auditLogs()[1]?.entityContext).toEqual({ name: 'Bob' });
  });

  it('rollback: discards the data and the audit rows written in the transaction, a deferred model included', async () => {
    const adapter = createAdapter({ entities: deferredPostMapping });

    await withContext(async () => {
      await adapter.create('User', { id: 'u0', name: 'Existing' });
      await expect(
        adapter.transaction(async (db) => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
          expect(db.find('User', 'u1')).toBeDefined();
          expect(db.find('Post', 'p1')).toBeDefined();
          expect(db.auditLogs().map((log) => log.entityId)).toEqual(['u0', 'u1', 'p1', 'p1']);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
    });
    await adapter.flush();

    expect(adapter.store.find('User', 'u1')).toBeUndefined();
    expect(adapter.store.find('Post', 'p1')).toBeUndefined();
    expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u0']);
  });

  it('deferred: inside a transaction the record is written in it before the operation returns, outside after flush', async () => {
    const committedWhenEnriched: boolean[] = [];
    const adapter: ReturnType<typeof createAdapter> = createAdapter({
      write: { mode: 'deferred' },
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users) => {
              committedWhenEnriched.push(users.every((user) => adapter.store.find('User', user.id) !== undefined));
              return users.map(() => null);
            },
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.transaction(async (db) => {
        await adapter.create('User', { id: 'u1', name: 'Alice' });
        expect(db.auditLogs().map((log) => log.entityId)).toEqual(['u1']);
        expect(adapter.store.auditLogs()).toHaveLength(0);
      });
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);

      await adapter.create('User', { id: 'u2', name: 'Bob' });
      await adapter.flush();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1', 'u2']);
    });

    expect(committedWhenEnriched).toEqual([false, true]);
  });

  describe('a transaction an operation of which its audit failed never commits', () => {
    const brokenPostAdapter = () =>
      createAdapter({
        entities: defineMapping({
          User: defineEntity<UserRow, Db>({ type: 'User' }),
          Post: defineEntity<PostRow, Db>({
            type: 'Post',
            idResolver: async (post) => {
              if (post.title === 'broken') throw new Error('entity id resolver is broken');
              return post.id;
            },
          }),
        }),
      });

    it('rejects with AuditRollbackError, whose cause is the AuditIncompleteError the callback caught, and rolls every write of it back', async () => {
      const adapter = brokenPostAdapter();

      const committed = withContext(() =>
        adapter.transaction(async () => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'broken' }).catch(() => undefined);
        }),
      );

      await expect(committed).rejects.toBeInstanceOf(AuditRollbackError);
      await expect(committed).rejects.toMatchObject({ cause: expect.any(AuditIncompleteError) });
      expect(adapter.store.find('User', 'u1')).toBeUndefined();
      expect(adapter.store.find('Post', 'p1')).toBeUndefined();
      expect(adapter.store.auditLogs()).toEqual([]);
    });

    it('rejects with AuditRollbackError when the callback caught the failure of an immediate audit write', async () => {
      const adapter = createAdapter({ write: { mode: 'awaited' } });
      const failure = new Error('audit-log store unavailable');
      const write = vi.spyOn(memoryWriteExecutor, 'write').mockRejectedValueOnce(failure);

      try {
        const committed = withContext(() =>
          adapter.transaction(async () => {
            await adapter.create('User', { id: 'u1', name: 'Alice' }).catch(() => undefined);
          }),
        );
        await expect(committed).rejects.toBeInstanceOf(AuditRollbackError);
        await expect(committed).rejects.toMatchObject({ cause: failure });
      } finally {
        write.mockRestore();
      }

      expect(adapter.store.find('User', 'u1')).toBeUndefined();
    });

    it('rolls a nested one back alone: the outer one, which catches its rejection, commits without its writes', async () => {
      const adapter = brokenPostAdapter();

      await withContext(() =>
        adapter.transaction(async () => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await expect(
            adapter.transaction(async () => {
              await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'broken' }).catch(() => undefined);
            }),
          ).rejects.toBeInstanceOf(AuditRollbackError);
        }),
      );

      expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
      expect(adapter.store.find('Post', 'p1')).toBeUndefined();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);
    });
  });

  describe('a transaction opened inside another joins it', () => {
    it('both resolve: the inner rows and audit rows are visible to the outer before it commits and land in the store once', async () => {
      const adapter = createAdapter();

      await withContext(() =>
        adapter.transaction(async (outer) => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await adapter.transaction(async () => {
            await adapter.create('User', { id: 'u2', name: 'Bob' });
          });
          expect(outer.find('User', 'u2')).toEqual({ id: 'u2', name: 'Bob' });
          expect(outer.auditLogs().map((log) => log.entityId)).toEqual(['u1', 'u2']);
          expect(adapter.store.find('User', 'u2')).toBeUndefined();
          expect(adapter.store.auditLogs()).toEqual([]);
        }),
      );

      expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
      expect(adapter.store.find('User', 'u2')).toEqual({ id: 'u2', name: 'Bob' });
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1', 'u2']);
    });

    it('the outer throws after the inner resolved: the inner rows and audit rows are discarded with the outer ones', async () => {
      const adapter = createAdapter();

      await withContext(async () => {
        await adapter.create('User', { id: 'u0', name: 'Existing' });
        await expect(
          adapter.transaction(async () => {
            await adapter.create('User', { id: 'u1', name: 'Alice' });
            await adapter.transaction(async () => {
              await adapter.create('User', { id: 'u2', name: 'Bob' });
            });
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
      });

      expect(adapter.store.find('User', 'u1')).toBeUndefined();
      expect(adapter.store.find('User', 'u2')).toBeUndefined();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u0']);
    });

    it('only the inner throws: its rows and audit rows are discarded, the outer ones commit', async () => {
      const adapter = createAdapter();

      await withContext(() =>
        adapter.transaction(async (outer) => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await expect(
            adapter.transaction(async () => {
              await adapter.create('User', { id: 'u2', name: 'Bob' });
              throw new Error('abort');
            }),
          ).rejects.toThrow('abort');
          expect(outer.find('User', 'u2')).toBeUndefined();
        }),
      );

      expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
      expect(adapter.store.find('User', 'u2')).toBeUndefined();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);
    });

    it('deferred: the inner records are written in the inner transaction, commit with the outer and are dropped when the outer throws', async () => {
      const adapter = createAdapter({ write: { mode: 'deferred' } });

      await withContext(async () => {
        await adapter.transaction(async (outer) => {
          await adapter.transaction(async () => {
            await adapter.create('User', { id: 'u1', name: 'Alice' });
          });
          expect(outer.auditLogs().map((log) => log.entityId)).toEqual(['u1']);
          expect(adapter.store.auditLogs()).toEqual([]);
        });
        expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);

        await expect(
          adapter.transaction(async () => {
            await adapter.transaction(async () => {
              await adapter.create('User', { id: 'u2', name: 'Bob' });
            });
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
      });
      await adapter.flush();

      expect(adapter.store.find('User', 'u2')).toBeUndefined();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);
    });
  });

  it('a detached write that fails is recorded in writeFailures and flush resolves', async () => {
    const adapter = createAdapter({ write: { mode: 'deferred' } });
    const failure = new Error('audit-log store unavailable');
    vi.spyOn(adapter.store, 'appendAuditLogs').mockImplementation(() => {
      throw failure;
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));
    await expect(adapter.flush()).resolves.toBeUndefined();

    expect(adapter.writeFailures).toEqual([
      { phase: 'log-write', records: [expect.objectContaining({ entityId: 'u1' })], error: failure },
    ]);
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('deferred inside a transaction: a write that fails rejects the operation, rolls the transaction back even when the callback catches it, and is recorded in writeFailures', async () => {
    const adapter = createAdapter({ write: { mode: 'deferred' } });
    const failure = new Error('audit-log store unavailable');
    const write = vi.spyOn(memoryWriteExecutor, 'write').mockRejectedValue(failure);

    try {
      await expect(
        withContext(() =>
          adapter.transaction(async () => {
            await expect(adapter.create('User', { id: 'u1', name: 'Alice' })).rejects.toBe(failure);
          }),
        ),
      ).rejects.toThrow(expect.objectContaining({ name: 'AuditRollbackError', cause: failure }));
    } finally {
      write.mockRestore();
    }

    expect(adapter.writeFailures).toEqual([
      { phase: 'log-write', records: [expect.objectContaining({ entityId: 'u1' })], error: failure },
    ]);
    expect(adapter.store.find('User', 'u1')).toBeUndefined();
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('an immediate write that fails rejects the operation, rolls it back and is recorded in writeFailures', async () => {
    const adapter = createAdapter();
    const failure = new Error('audit-log store unavailable');
    const write = vi.spyOn(memoryWriteExecutor, 'write').mockRejectedValue(failure);

    try {
      await expect(withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }))).rejects.toBe(failure);
    } finally {
      write.mockRestore();
    }

    expect(adapter.writeFailures).toEqual([expect.objectContaining({ phase: 'log-write', error: failure })]);
    expect(adapter.store.find('User', 'u1')).toBeUndefined();
  });

  describe('a record build that fails after the write', () => {
    const failure = new Error('actor enricher is broken');
    const adapterWithFailingEnricher = (mode: WriteMode) => {
      const observer = vi.fn<AuditObserver>();
      const adapter = createAdapter({
        write: { mode },
        observer,
        actorContext: {
          enricher: async () => {
            throw failure;
          },
        },
      });
      return { adapter, observer };
    };
    const outcomeWith = (status: 'incomplete' | 'not-committed', isolation: AuditIsolation) => ({
      model: 'User',
      operation: 'create',
      status,
      records: 0,
      failures: [{ phase: 'diff-generation', error: failure }],
      unrecordedWrites: [],
      isolation,
    });

    it('deferred outside a transaction: keeps the write, reports it incomplete with the diff-generation failure to the observer, which takes the log, and writes no record', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { adapter, observer } = adapterWithFailingEnricher('deferred');

      try {
        await expect(withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }))).resolves.toBeUndefined();
        await adapter.flush();

        expect(observer.mock.calls).toEqual([[outcomeWith('incomplete', { kind: 'no-transaction' })]]);
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
      expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
      expect(adapter.store.auditLogs()).toEqual([]);
    });

    it('atomic: rejects with the error, rolls the write back, reports it not committed with the diff-generation failure and writes no record', async () => {
      const { adapter, observer } = adapterWithFailingEnricher('atomic');

      await expect(withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }))).rejects.toBe(failure);

      expect(observer.mock.calls).toEqual([[outcomeWith('not-committed', { kind: 'undeclared' })]]);
      expect(adapter.store.find('User', 'u1')).toBeUndefined();
      expect(adapter.store.auditLogs()).toEqual([]);
    });
  });

  it("an entity's writeMode: a model without one writes atomically in an implicit transaction, one whose entity sets deferred detached", async () => {
    const committedWhenEnriched = new Map<string, boolean>();
    const adapter: ReturnType<typeof createAdapter> = createAdapter({
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users) => {
              committedWhenEnriched.set(
                'User',
                users.every((user) => adapter.store.find('User', user.id) !== undefined),
              );
              return users.map(() => null);
            },
          },
        }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          writeMode: 'deferred',
          entityContext: {
            enricher: async (posts) => {
              committedWhenEnriched.set(
                'Post',
                posts.every((post) => adapter.store.find('Post', post.id) !== undefined),
              );
              return posts.map(() => null);
            },
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      expect(adapter.store.auditLogs().map((log) => log.entityType)).toEqual(['User']);
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });
    await adapter.flush();

    expect(adapter.store.auditLogs().map((log) => log.entityType)).toEqual(['User', 'Post']);
    expect(committedWhenEnriched).toEqual(
      new Map([
        ['User', false],
        ['Post', true],
      ]),
    );
  });
});

describe('a write a callback issues while the audit processes a write', () => {
  const intruder: PostRow = { id: 'p9', authorId: 'u1', title: 'written by a callback' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Keeps what `write` rejects with and rethrows it, so the enricher still fails with that error */
  const attempt = async (rejections: unknown[], write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      rejections.push(error);
      throw error;
    }
  };

  it.each([
    { scope: 'atomic, in the implicit transaction', mode: 'atomic', explicit: false, committed: false },
    { scope: 'awaited, outside any transaction', mode: 'awaited', explicit: false, committed: true },
    { scope: 'deferred, detached', mode: 'deferred', explicit: false, committed: true },
    { scope: 'awaited, inside a transaction', mode: 'awaited', explicit: true, committed: false },
    { scope: 'deferred, inside a transaction', mode: 'deferred', explicit: true, committed: false },
  ] as const)(
    'rejects with AuditReentrantWriteError a write of a model in entities an enricher makes through its handle, $scope',
    async ({ mode, explicit, committed }) => {
      const rejections: unknown[] = [];
      const observer = vi.fn<AuditObserver>();
      const adapter = createAdapter({
        write: { mode },
        observer,
        entities: defineMapping({
          User: defineEntity<UserRow, Db>({
            type: 'User',
            entityContext: {
              enricher: async (users, db) => {
                await attempt(rejections, () => db.create('Post', intruder));
                return users.map(() => null);
              },
            },
          }),
          Post: defineEntity<PostRow, Db>({ type: 'Post' }),
        }),
      });

      const write = () => adapter.create('User', { id: 'u1', name: 'Alice' });
      const caught = await withContext(() => (explicit ? adapter.transaction(write) : write())).then(
        () => undefined,
        (error: unknown) => error,
      );
      await adapter.flush();

      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toBeInstanceOf(AuditReentrantWriteError);
      expect(rejections[0]).toMatchObject({ modelName: 'Post', operationModelName: 'Post', operation: 'create' });
      expect(caught).toBe(committed ? undefined : rejections[0]);
      expect(adapter.store.find('User', 'u1')).toEqual(committed ? { id: 'u1', name: 'Alice' } : undefined);
      expect(observer.mock.calls).toEqual([
        [
          {
            model: 'User',
            operation: 'create',
            status: committed ? 'incomplete' : 'not-committed',
            records: 0,
            failures: [{ phase: 'diff-generation', error: rejections[0] }],
            unrecordedWrites: [],
            isolation: { kind: mode === 'atomic' || explicit ? 'undeclared' : 'no-transaction' },
          },
        ],
      ]);
      expect(adapter.store.find('Post', 'p9')).toBeUndefined();
      expect(adapter.store.auditLogs()).toEqual([]);
    },
  );

  it('logs to the console, without an observer, the rejection of a write of a model in entities an enricher makes through its handle, awaited, and keeps the write', async () => {
    const rejections: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = createAdapter({
      write: { mode: 'awaited' },
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users, db) => {
              await attempt(rejections, () => db.create('Post', intruder));
              return users.map(() => null);
            },
          },
        }),
        Post: defineEntity<PostRow, Db>({ type: 'Post' }),
      }),
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(rejections).toEqual([expect.any(AuditReentrantWriteError)]);
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.find('Post', 'p9')).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      '[db-audit-core] create on User committed without some of its audit records; diff-generation failure:',
      expect.stringContaining('A write to Post was rejected'),
    );
  });

  it('rejects a write of a model in entities an idResolver makes through its handle, and reports the resolver failed', async () => {
    const rejections: unknown[] = [];
    const adapter = createAdapter({
      write: { mode: 'awaited' },
      observer: async () => {},
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          idResolver: async (user, db) => {
            await attempt(rejections, () => db.create('Post', intruder));
            return user.id;
          },
        }),
        Post: defineEntity<PostRow, Db>({ type: 'Post' }),
      }),
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(rejections).toEqual([expect.any(AuditReentrantWriteError)]);
    expect(adapter.resolverFailures).toEqual([
      expect.objectContaining({ phase: 'id-resolver-call', modelName: 'User', error: rejections[0] }),
    ]);
    expect(adapter.store.find('Post', 'p9')).toBeUndefined();
  });

  it('rejects a write of a model in entities the observer makes, without an outcome of its own', async () => {
    const rejections: unknown[] = [];
    const observed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter: ReturnType<typeof createAdapter> = createAdapter({
      observer: async (outcome) => {
        observed.push(outcome.model);
        if (outcome.model === 'User') {
          await attempt(rejections, () => adapter.create('Post', intruder));
        }
      },
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(rejections).toEqual([expect.any(AuditReentrantWriteError)]);
    expect(observed).toEqual(['User']);
    expect(adapter.store.find('Post', 'p9')).toBeUndefined();
  });

  it('runs a write of a model not in entities a callback makes through its handle, and a write of the caller afterwards is audited', async () => {
    const adapter = createAdapter({
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users, db) => {
              if (db.find('Post', intruder.id) === undefined) {
                await db.create('Post', intruder);
              }
              return users.map(() => null);
            },
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.update('User', 'u1', { name: 'Bob' });
    });

    expect(adapter.store.find('Post', 'p9')).toEqual(intruder);
    expect(adapter.store.auditLogs().map(({ action, entityType }) => `${action}:${entityType}`)).toEqual([
      'create:User',
      'update:User',
    ]);
  });
});

describe('the audit gate', () => {
  const userOnly = defineMapping({ User: defineEntity<UserRow, Db>({ type: 'User' }) });

  it('rejects a write without an audit context by default, leaving the store unchanged', async () => {
    const adapter = createAdapter();

    await expect(adapter.create('User', { id: 'u1', name: 'Alice' })).rejects.toBeInstanceOf(AuditContextMissingError);

    expect(adapter.store.find('User', 'u1')).toBeUndefined();
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('runs a write without an audit context unaudited when requireContext is false', async () => {
    const adapter = createAdapter({ requireContext: false });

    await adapter.create('User', { id: 'u1', name: 'Alice' });

    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it.each([
    ['create', (adapter: ReturnType<typeof createAdapter>) => adapter.create('User', { id: 'u2', name: 'Bob' })],
    ['update', (adapter: ReturnType<typeof createAdapter>) => adapter.update('User', 'u1', { name: 'Changed' })],
    ['delete', (adapter: ReturnType<typeof createAdapter>) => adapter.delete('User', 'u1')],
  ])(
    'rejects a %s without an audit context when requireContext is true, leaving the store unchanged',
    async (_operation, write) => {
      const adapter = createAdapter({ requireContext: true });
      await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

      await expect(write(adapter)).rejects.toBeInstanceOf(AuditContextMissingError);
      await expect(write(adapter)).rejects.toMatchObject({ modelName: 'User', operationModelName: 'User' });
      expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
      expect(adapter.store.find('User', 'u2')).toBeUndefined();
      expect(adapter.store.auditLogs()).toHaveLength(1);
    },
  );

  it('rejects without an audit context a model the requireContext function holds for, and runs another unaudited', async () => {
    const adapter = createAdapter({ requireContext: (model) => model === 'Post' });

    await adapter.create('User', { id: 'u1', name: 'Alice' });
    await expect(adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' })).rejects.toMatchObject({
      name: 'AuditContextMissingError',
      modelName: 'Post',
    });

    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.find('Post', 'p1')).toBeUndefined();
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('runs without an audit context a write of a model that is not in entities, even with requireContext: true', async () => {
    const adapter = createAdapter({ entities: userOnly, requireContext: true });

    await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });

    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'Hello' });
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('writes, with an audit context, a model that is not in entities without a record, calling no actor enricher', async () => {
    const enricher = vi.fn(async () => ({}));
    const adapter = createAdapter({
      entities: userOnly,
      actorContext: { enricher },
    });

    await withContext(() => adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' }));
    await adapter.flush();

    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'Hello' });
    expect(adapter.store.auditLogs()).toEqual([]);
    expect(enricher).not.toHaveBeenCalled();
  });
});

describe('the outcome of each write', () => {
  const statusesOf = (observer: ReturnType<typeof vi.fn<AuditObserver>>) =>
    observer.mock.calls.map(([{ model, status, records }]) => ({ model, status, records }));

  it('is complete for an atomic write once its implicit transaction has committed', async () => {
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({ observer });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(observer.mock.calls).toEqual([
      [
        {
          model: 'User',
          operation: 'create',
          status: 'complete',
          records: 1,
          failures: [],
          unrecordedWrites: [],
          isolation: { kind: 'undeclared' },
        },
      ],
    ]);
  });

  it.each(['log', 'ignore'] as const)(
    "is complete for an atomic write whose enrichers fall back under onError '%s', listing each as an enrichment failure",
    async (onError) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failing = (error: Error) => ({
        enricher: async (): Promise<never> => {
          throw error;
        },
        onError,
      });
      const actorError = new Error('actor lookup failed');
      const entityError = new Error('entity lookup failed');
      const aggregateError = new Error('aggregate lookup failed');
      const observer = vi.fn<AuditObserver>();
      const adapter = createAdapter({
        observer,
        actorContext: failing(actorError),
        entities: defineMapping({
          User: defineEntity<UserRow, Db>({ type: 'User' }),
          Post: defineEntity<PostRow, Db>({
            type: 'Post',
            selfAggregate: false,
            aggregates: [to('User', foreignKey('authorId'), { aggregateContext: failing(aggregateError) })],
            entityContext: failing(entityError),
          }),
        }),
      });

      await withContext(() => adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' }));

      expect(observer.mock.calls).toEqual([
        [
          {
            model: 'Post',
            operation: 'create',
            status: 'complete',
            records: 1,
            failures: [
              { phase: 'enrichment', enricher: 'actor', error: actorError },
              { phase: 'enrichment', enricher: 'entity', error: entityError },
              { phase: 'enrichment', enricher: 'aggregate', error: aggregateError },
            ],
            unrecordedWrites: [],
            isolation: { kind: 'undeclared' },
          },
        ],
      ]);
      expect(adapter.store.auditLogs()).toEqual([
        expect.objectContaining({ entityId: 'p1', actorContext: null, entityContext: null, aggregateContext: null }),
      ]);
    },
  );

  describe('isolation', () => {
    const isolationsOf = (observer: ReturnType<typeof vi.fn<AuditObserver>>) =>
      observer.mock.calls.map(([{ isolation }]) => isolation);

    it.each(['awaited', 'deferred'] as const)(
      'is no-transaction for a %s write outside any transaction, whose read and write share none',
      async (mode) => {
        const observer = vi.fn<AuditObserver>();
        const adapter = createAdapter({ observer, write: { mode } });

        await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));
        await adapter.flush();

        expect(isolationsOf(observer)).toEqual([{ kind: 'no-transaction' }]);
      },
    );

    it.each(['atomic', 'awaited', 'deferred'] as const)(
      'is undeclared for a %s write in a transaction and in one nested in it',
      async (mode) => {
        const observer = vi.fn<AuditObserver>();
        const adapter = createAdapter({ observer, write: { mode } });

        await withContext(() =>
          adapter.transaction(async () => {
            await adapter.create('User', { id: 'u1', name: 'Alice' });
            await adapter.transaction(async () => {
              await adapter.create('User', { id: 'u2', name: 'Bob' });
            });
          }),
        );

        expect(isolationsOf(observer)).toEqual([{ kind: 'undeclared' }, { kind: 'undeclared' }]);
      },
    );
  });

  it('is reported for each write of a transaction once the outermost one has committed, a nested one included', async () => {
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({ observer });
    const reportedInside: number[] = [];

    await withContext(() =>
      adapter.transaction(async () => {
        await adapter.create('User', { id: 'u1', name: 'Alice' });
        await adapter.transaction(async () => {
          await adapter.create('User', { id: 'u2', name: 'Bob' });
        });
        reportedInside.push(observer.mock.calls.length);
      }),
    );

    expect(reportedInside).toEqual([0]);
    expect(statusesOf(observer)).toEqual([
      { model: 'User', status: 'complete', records: 1 },
      { model: 'User', status: 'complete', records: 1 },
    ]);
  });

  it('is not-committed, and never complete, for the writes of a transaction that throws after they succeeded', async () => {
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({ observer });

    await expect(
      withContext(() =>
        adapter.transaction(async () => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await adapter.create('User', { id: 'u2', name: 'Bob' });
          throw new Error('callback failed');
        }),
      ),
    ).rejects.toThrow('callback failed');

    expect(statusesOf(observer)).toEqual([
      { model: 'User', status: 'not-committed', records: 1 },
      { model: 'User', status: 'not-committed', records: 1 },
    ]);
  });

  it('is not-committed for a write of a nested transaction that rolled back, reported once the outermost one settles', async () => {
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({ observer });
    const reportedInside: number[] = [];

    await withContext(() =>
      adapter.transaction(async () => {
        await adapter
          .transaction(async () => {
            await adapter.create('User', { id: 'u1', name: 'Alice' });
            throw new Error('nested callback failed');
          })
          .catch(() => undefined);
        reportedInside.push(observer.mock.calls.length);
        await adapter.create('User', { id: 'u2', name: 'Bob' });
      }),
    );

    expect(reportedInside).toEqual([0]);
    expect(statusesOf(observer)).toEqual([
      { model: 'User', status: 'not-committed', records: 1 },
      { model: 'User', status: 'complete', records: 1 },
    ]);
  });

  it('is unaudited, for no-context, for a write run without an audit context', async () => {
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({ observer, requireContext: false });

    await adapter.create('User', { id: 'u1', name: 'Alice' });

    expect(observer.mock.calls).toEqual([
      [
        {
          model: 'User',
          operation: 'create',
          status: 'unaudited',
          unauditedReason: 'no-context',
          records: 0,
          failures: [],
          unrecordedWrites: [],
          isolation: { kind: 'no-transaction' },
        },
      ],
    ]);
  });

  it('is not-committed for a write the audit gate rejected', async () => {
    const observer = vi.fn<AuditObserver>();
    const adapter = createAdapter({ observer, requireContext: true });

    await expect(adapter.create('User', { id: 'u1', name: 'Alice' })).rejects.toBeInstanceOf(AuditContextMissingError);

    expect(statusesOf(observer)).toEqual([{ model: 'User', status: 'not-committed', records: 0 }]);
  });
});

describe('record composition', () => {
  it('masks the built-in sensitive fields and redactFields, and stores Date and BigInt values as strings', async () => {
    const adapter = createAdapter({ redactFields: ['email'] });
    const createdAt = new Date('2026-01-02T03:04:05.000Z');

    await withContext(() =>
      adapter.create('User', {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        password: 'placeholder',
        createdAt,
        balance: 10n,
      }),
    );

    expect(adapter.store.auditLogs()[0]?.after).toEqual({
      id: 'u1',
      name: 'Alice',
      email: { redacted: true, hadValue: true },
      password: { redacted: true, hadValue: true },
      createdAt: '2026-01-02T03:04:05.000Z',
      balance: '10',
    });
    expect(adapter.store.find('User', 'u1')?.createdAt).toBe(createdAt);
  });

  it('redaction: a sensitive key inside a class instance among the column values is masked, the stored row keeps the instance', async () => {
    class Credentials {
      constructor(
        readonly user: string,
        readonly token: string,
      ) {}
    }
    const adapter = createAdapter();
    const credentials = new Credentials('alice', 'placeholder-token');

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice', credentials }));

    expect(adapter.store.auditLogs()[0]?.after).toEqual({
      id: 'u1',
      name: 'Alice',
      credentials: { user: 'alice', token: { redacted: true, hadValue: true } },
    });
    expect(adapter.store.find('User', 'u1')?.credentials).toBe(credentials);
  });

  it('applies the serializers before the built-in conversions, the stored row keeping the value', async () => {
    const adapter = createAdapter({
      serializers: [(value) => (value instanceof Uint8Array ? `bytes:${value.length}` : UNHANDLED)],
    });
    const avatar = new Uint8Array([1, 2, 3]);

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice', avatar }));

    expect(adapter.store.auditLogs()[0]?.after).toEqual({ id: 'u1', name: 'Alice', avatar: 'bytes:3' });
    expect(adapter.store.find('User', 'u1')?.avatar).toBe(avatar);
  });
});

describe('identityOf', () => {
  it('a single-column key is the string of its value', () => {
    expect(identityOf(schema, 'User', { id: 'u1', name: 'Alice' })).toBe('u1');
    expect(identityOf({ Counter: { primaryKey: ['id'] } }, 'Counter', { id: 42n })).toBe('42');
  });

  it('a composite key is a JSON array in primary-key order, with BigInt values as strings', () => {
    const compositeSchema: MemorySchema<'Membership'> = { Membership: { primaryKey: ['orgId', 'seq', 'userId'] } };

    expect(
      identityOf(compositeSchema, 'Membership', { userId: 'u1', seq: 9007199254740993n, orgId: 7, role: 'admin' }),
    ).toBe('[7,"9007199254740993","u1"]');
  });
});
