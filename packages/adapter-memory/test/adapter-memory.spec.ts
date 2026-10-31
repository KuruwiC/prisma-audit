import type { AuditActor, AuditErrorObserver, AuditRecord } from '@kuruwic/db-audit-core';
import {
  AuditContextMissingError,
  createAsyncLocalStorageProvider,
  defineEntities,
  defineEntity,
  foreignKey,
  to,
  UNHANDLED,
} from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryAuditAdapter,
  identityOf,
  type MemoryAuditOptions,
  type MemoryHandle,
  type MemorySchema,
  memoryWriteExecutor,
} from '../src/index.js';

type ModelName = 'User' | 'Post';
type Db = MemoryHandle<ModelName>;
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

  it('an idResolver that throws: its row gets no record and is listed in resolverFailures, the write and the other rows are recorded', async () => {
    const resolverError = new Error('entity id resolver is broken');
    const observer = vi.fn<AuditErrorObserver>();
    const adapter = createAdapter({
      errorObserver: observer,
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
      params: { identity: 'p1', resolver: { kind: 'entity' } },
      error: resolverError,
    };
    expect(adapter.resolverFailures).toEqual([failure]);
    expect(observer).toHaveBeenCalledExactlyOnceWith(failure);
    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'broken' });
    expect(adapter.store.auditLogs().map(({ entityType, entityId }) => `${entityType}:${entityId}`)).toEqual([
      'User:u1',
      'Post:p2',
    ]);
    expect(adapter.writeFailures).toEqual([]);
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

  it('rollback: discards the data, the immediate audit rows and the after-commit plans', async () => {
    const adapter = createAdapter({ write: { awaited: (model) => model === 'User' } });

    await withContext(async () => {
      await adapter.create('User', { id: 'u0', name: 'Existing' });
      await expect(
        adapter.transaction(async (db) => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
          await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
          expect(db.find('User', 'u1')).toBeDefined();
          expect(db.find('Post', 'p1')).toBeDefined();
          expect(db.auditLogs().map((log) => log.entityId)).toEqual(['u0', 'u1']);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
    });
    await adapter.flush();

    expect(adapter.store.find('User', 'u1')).toBeUndefined();
    expect(adapter.store.find('Post', 'p1')).toBeUndefined();
    expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u0']);
  });

  it('awaited false: inside a transaction the record lands after commit, outside after flush', async () => {
    const handles: unknown[] = [];
    const adapter = createAdapter({
      write: { awaited: false },
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users, db) => {
              handles.push(db);
              return users.map(() => null);
            },
          },
        }),
      }),
    });

    await withContext(async () => {
      await adapter.transaction(async (db) => {
        await adapter.create('User', { id: 'u1', name: 'Alice' });
        expect(db.auditLogs()).toHaveLength(0);
        expect(adapter.store.auditLogs()).toHaveLength(0);
      });
      await adapter.flush();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1']);

      await adapter.create('User', { id: 'u2', name: 'Bob' });
      await adapter.flush();
      expect(adapter.store.auditLogs().map((log) => log.entityId)).toEqual(['u1', 'u2']);
    });

    expect(handles[0]).not.toBe(adapter.store);
    expect(handles[1]).toBe(adapter.store);
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

    it('awaited false: the inner after-commit records start once the outer commits and are dropped when the outer throws', async () => {
      const adapter = createAdapter({ write: { awaited: false } });

      await withContext(async () => {
        await adapter.transaction(async () => {
          await adapter.transaction(async () => {
            await adapter.create('User', { id: 'u1', name: 'Alice' });
          });
          await adapter.flush();
          expect(adapter.store.auditLogs()).toEqual([]);
        });
        await adapter.flush();
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
    const adapter = createAdapter({ write: { awaited: false } });
    const failure = new Error('audit-log store unavailable');
    vi.spyOn(adapter.store, 'appendAuditLogs').mockImplementation(() => {
      throw failure;
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));
    await expect(adapter.flush()).resolves.toBeUndefined();

    expect(adapter.writeFailures).toEqual([
      { phase: 'log-write', modelName: 'User', operation: 'write', params: [expect.any(Object)], error: failure },
    ]);
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('a write after commit that fails is recorded in writeFailures, the transaction stays committed and flush resolves', async () => {
    const adapter = createAdapter({ write: { awaited: false } });
    const failure = new Error('audit-log store unavailable');
    const write = vi.spyOn(memoryWriteExecutor, 'write').mockRejectedValue(failure);

    try {
      await withContext(() =>
        adapter.transaction(async () => {
          await adapter.create('User', { id: 'u1', name: 'Alice' });
        }),
      );
      await expect(adapter.flush()).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }

    expect(adapter.writeFailures).toEqual([
      { phase: 'log-write', modelName: 'User', operation: 'write', params: [expect.any(Object)], error: failure },
    ]);
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
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
    const adapterWithFailingEnricher = (awaited: boolean) => {
      const observer = vi.fn<AuditErrorObserver>();
      const adapter = createAdapter({
        write: { awaited },
        errorObserver: observer,
        actorContext: {
          enricher: async () => {
            throw failure;
          },
        },
      });
      return { adapter, observer };
    };
    const diffGeneration = {
      phase: 'diff-generation',
      modelName: 'User',
      operation: 'create',
      params: { identity: 'u1' },
      error: failure,
    };

    it('awaited false outside a transaction: keeps the write, notifies diff-generation once, leaves the drop to the observer and writes no record', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { adapter, observer } = adapterWithFailingEnricher(false);

      try {
        await expect(withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }))).resolves.toBeUndefined();
        await adapter.flush();

        expect(observer.mock.calls).toEqual([[diffGeneration]]);
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
      expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
      expect(adapter.store.auditLogs()).toEqual([]);
    });

    it('atomic: rejects with the error, rolls the write back, notifies diff-generation once and writes no record', async () => {
      const { adapter, observer } = adapterWithFailingEnricher(true);

      await expect(withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }))).rejects.toBe(failure);

      expect(observer.mock.calls).toEqual([[diffGeneration]]);
      expect(adapter.store.find('User', 'u1')).toBeUndefined();
      expect(adapter.store.auditLogs()).toEqual([]);
    });
  });

  it('awaited as a function: a model it returns true for writes atomically in an implicit transaction, another detached', async () => {
    const handles = new Map<string, unknown>();
    const adapter = createAdapter({
      write: { awaited: (model) => model === 'User' },
      entities: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async (users, db) => {
              handles.set('User', db);
              return users.map(() => null);
            },
          },
        }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          entityContext: {
            enricher: async (posts, db) => {
              handles.set('Post', db);
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
    expect(handles.get('User')).not.toBe(adapter.store);
    expect(handles.get('Post')).toBe(adapter.store);
  });
});

describe('samplingRate', () => {
  it('samplingRate 0: the row is written and no record is', async () => {
    const adapter = createAdapter({ samplingRate: 0 });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('samplingRate 0 inside a transaction: the row is written on the transaction handle and commits or rolls back with it', async () => {
    const adapter = createAdapter({ samplingRate: 0 });

    await withContext(async () => {
      await adapter.transaction(async (db) => {
        await adapter.create('User', { id: 'u1', name: 'Alice' });
        expect(db.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
        expect(adapter.store.find('User', 'u1')).toBeUndefined();
      });
      await expect(
        adapter.transaction(async () => {
          await adapter.create('User', { id: 'u2', name: 'Bob' });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
    });

    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.find('User', 'u2')).toBeUndefined();
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('samplingRate as a function: a model it returns 1 for is audited, one it returns 0 for is not', async () => {
    const adapter = createAdapter({ samplingRate: (model) => (model === 'User' ? 1 : 0) });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });

    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'Hello' });
    expect(adapter.store.auditLogs().map((log) => log.entityType)).toEqual(['User']);
  });
});

describe('the audit gate', () => {
  const userOnly = defineMapping({ User: defineEntity<UserRow, Db>({ type: 'User' }) });

  it('runs a write without an audit context unaudited by default', async () => {
    const adapter = createAdapter();

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

  it('rejects a write without an audit context at a samplingRate of 0', async () => {
    const adapter = createAdapter({ requireContext: true, samplingRate: 0 });

    await expect(adapter.create('User', { id: 'u1', name: 'Alice' })).rejects.toBeInstanceOf(AuditContextMissingError);
    expect(adapter.store.find('User', 'u1')).toBeUndefined();
  });

  it('runs without an audit context a write of a model that is not in entities, even with requireContext: true', async () => {
    const adapter = createAdapter({ entities: userOnly, requireContext: true });

    await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });

    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'Hello' });
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('writes, with an audit context, a model that is not in entities without a record, calling no policy function or actor enricher', async () => {
    const samplingRate = vi.fn(() => 1);
    const awaited = vi.fn(() => true);
    const enricher = vi.fn(async () => ({}));
    const adapter = createAdapter({
      entities: userOnly,
      samplingRate,
      write: { awaited },
      actorContext: { enricher },
    });

    await withContext(() => adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' }));
    await adapter.flush();

    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'Hello' });
    expect(adapter.store.auditLogs()).toEqual([]);
    expect(samplingRate).not.toHaveBeenCalled();
    expect(awaited).not.toHaveBeenCalled();
    expect(enricher).not.toHaveBeenCalled();
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
