import type { AuditActor, AuditRecord } from '@kuruwic/db-audit-core';
import {
  createAsyncLocalStorageProvider,
  defineAggregateMapping,
  defineEntity,
  foreignKey,
  to,
} from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryAuditAdapter,
  type MemoryAuditOptions,
  type MemoryHandle,
  type MemorySchema,
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

const defineMapping = defineAggregateMapping<ModelName, Db>();

const baseMapping = defineMapping({
  User: defineEntity<UserRow, Db>({ type: 'User' }),
  Post: defineEntity<PostRow, Db>({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
});

const createAdapter = (overrides: Partial<MemoryAuditOptions<ModelName>> = {}) =>
  createMemoryAuditAdapter<ModelName>({ schema, provider, aggregateMapping: baseMapping, ...overrides });

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
    const adapter = createAdapter({ excludeFields: ['updatedAt'] });

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

  it('entity enricher: reads another table through the database handle into entityContext', async () => {
    const adapter = createAdapter({
      aggregateMapping: defineMapping({
        User: defineEntity<UserRow, Db>({ type: 'User' }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          context: {
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
      contextEnricher: {
        actor: {
          enricher: async (currentActor, db) => ({ email: db.find('User', currentActor.id)?.email ?? null }),
        },
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
      aggregateMapping: defineMapping({
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
              context: {
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
      aggregateMapping: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          context: {
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
    const adapter = createAdapter({ awaitWriteIf: (model) => model === 'User' });

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

  it('awaitWrite false: inside a transaction the record lands after commit, outside after flush', async () => {
    const handles: unknown[] = [];
    const adapter = createAdapter({
      awaitWrite: false,
      aggregateMapping: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          context: {
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

  it('a detached write that fails is recorded in writeFailures and flush resolves', async () => {
    const adapter = createAdapter({ awaitWrite: false });
    const failure = new Error('audit-log store unavailable');
    vi.spyOn(adapter.store, 'appendAuditLogs').mockImplementation(() => {
      throw failure;
    });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));
    await expect(adapter.flush()).resolves.toBeUndefined();

    expect(adapter.writeFailures).toEqual([failure]);
    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('awaitWriteIf by tag: a tagged model writes atomically in an implicit transaction, an untagged one detached', async () => {
    const handles = new Map<string, unknown>();
    const adapter = createAdapter({
      awaitWriteIf: (_model, tags) => tags.includes('critical'),
      aggregateMapping: defineMapping({
        User: defineEntity<UserRow, Db>({
          type: 'User',
          tags: ['critical'],
          context: {
            enricher: async (users, db) => {
              handles.set('User', db);
              return users.map(() => null);
            },
          },
        }),
        Post: defineEntity<PostRow, Db>({
          type: 'Post',
          context: {
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

describe('sampling', () => {
  it('sampling 0: the row is written and no record is', async () => {
    const adapter = createAdapter({ sampling: 0 });

    await withContext(() => adapter.create('User', { id: 'u1', name: 'Alice' }));

    expect(adapter.store.find('User', 'u1')).toEqual({ id: 'u1', name: 'Alice' });
    expect(adapter.store.auditLogs()).toEqual([]);
  });

  it('samplingIf by tag: a tagged model is audited, an untagged one is not', async () => {
    const adapter = createAdapter({
      sampling: 1,
      samplingIf: (_model, tags) => (tags.includes('critical') ? 1 : 0),
      aggregateMapping: defineMapping({
        User: defineEntity<UserRow, Db>({ type: 'User', tags: ['critical'] }),
        Post: defineEntity<PostRow, Db>({ type: 'Post' }),
      }),
    });

    await withContext(async () => {
      await adapter.create('User', { id: 'u1', name: 'Alice' });
      await adapter.create('Post', { id: 'p1', authorId: 'u1', title: 'Hello' });
    });

    expect(adapter.store.find('Post', 'p1')).toEqual({ id: 'p1', authorId: 'u1', title: 'Hello' });
    expect(adapter.store.auditLogs().map((log) => log.entityType)).toEqual(['User']);
  });
});

describe('record composition', () => {
  it('redaction and serialization: sensitive fields are masked, Date and BigInt become strings', async () => {
    const adapter = createAdapter({ redact: { fields: ['email'] } });
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
});
