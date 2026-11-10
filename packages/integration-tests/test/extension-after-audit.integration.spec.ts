/**
 * Integration tests: query extensions applied to the audited client after the audit. They may change
 * written values and row-picking values, but must continue the write once (again only after a failed
 * attempt) with the same relations and rows in the same order, else `AuditExtensionContinuationError`.
 * The audit's own queries pass through the extension's hooks, so before/after states hold the values
 * the application reads.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import {
  AuditExtensionContinuationError,
  createAuditClient,
  defineEntity,
  flushAllPendingWrites,
  type WriteConfig,
  type WriteMode,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'extension-after-audit-actor' },
};

const ENCODED = 'encoded:';
const encode = (value: string) => `${ENCODED}${[...value].reverse().join('')}`;
const decode = (value: string) =>
  value.startsWith(ENCODED) ? [...value.slice(ENCODED.length)].reverse().join('') : value;

/** Prisma's serializer replaces this object with `value` */
const sentAs = <T extends object>(value: T): T =>
  Object.defineProperty<T>(Object.create(null), 'toJSON', { value: () => value, enumerable: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withName = (data: unknown, transform: (value: string) => string): unknown =>
  isRecord(data) && typeof data.name === 'string' ? { ...data, name: transform(data.name) } : data;

const decodedResult = (result: unknown): unknown =>
  Array.isArray(result) ? result.map((row) => withName(row, decode)) : withName(result, decode);

/** Stores User names encoded and returns them decoded */
const nameEncoding = Prisma.defineExtension({
  name: 'name-encoding',
  query: {
    user: {
      async $allOperations({ args, query }) {
        const encodedArgs = isRecord(args)
          ? {
              ...args,
              ...('data' in args ? { data: withName(args.data, encode) } : {}),
              ...('create' in args ? { create: withName(args.create, encode) } : {}),
              ...('update' in args ? { update: withName(args.update, encode) } : {}),
            }
          : args;
        return decodedResult(await query(encodedArgs as typeof args));
      },
    },
  },
});

describe('query extensions applied after the audit', () => {
  const disposers: Array<() => Promise<void>> = [];
  let raw: PrismaClient;

  beforeAll(() => {
    raw = createBasePrisma();
  });

  afterAll(async () => {
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
    await raw.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(raw);
  });

  const createClient = (mode: WriteMode, writer?: WriteConfig['writer']) => {
    const base = createBasePrisma();
    disposers.push(() => base.$disconnect());
    const provider = createAsyncLocalStorageProvider();
    const audited = createAuditClient(base, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: { User: defineEntity({ type: 'User' }), Post: defineEntity({ type: 'Post' }) },
      write: { mode, writer },
    });
    const withContext = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
    return { base, audited, withContext };
  };

  const auditLogsOfUser = (id: string) =>
    raw.auditLog.findMany({
      where: { entityType: 'User', entityId: id },
      select: { action: true, before: true, after: true },
      orderBy: { createdAt: 'asc' },
    });

  describe.each([
    { scope: 'outside any transaction, written once the write has committed', mode: 'awaited', inTransaction: false },
    { scope: 'outside any transaction, written in the background', mode: 'deferred', inTransaction: false },
    { scope: 'in the transaction the client opens for an atomic write', mode: 'atomic', inTransaction: false },
    { scope: 'in an interactive $transaction', mode: 'awaited', inTransaction: true },
  ] as const)('an extension that changes the values a write writes, $scope', ({ mode, inTransaction }) => {
    it('runs the write with the values it writes, and the audit records the values the application reads', async () => {
      const { audited, withContext } = createClient(mode);
      const client = audited.$extends(nameEncoding);
      type Users = Pick<typeof client, 'user'>['user'];
      const run = <T>(fn: (users: Users) => Promise<T>) =>
        withContext(() => (inTransaction ? client.$transaction((tx) => fn(tx.user)) : fn(client.user)));

      const created = await run((users) => users.create({ data: { email: 'encoded@example.com', name: 'Plain' } }));
      const updated = await run((users) => users.update({ where: { id: created.id }, data: { name: 'Changed' } }));

      await flushAllPendingWrites();

      expect(created.name).toBe('Plain');
      expect(updated.name).toBe('Changed');
      expect(await raw.user.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        name: encode('Changed'),
      });
      expect(await auditLogsOfUser(created.id)).toEqual([
        { action: 'create', before: null, after: expect.objectContaining({ name: 'Plain' }) },
        {
          action: 'update',
          before: expect.objectContaining({ name: 'Plain' }),
          after: expect.objectContaining({ name: 'Changed' }),
        },
      ]);
    });
  });

  it.each([{ mode: 'awaited' }, { mode: 'deferred' }] as const)(
    'hands the writer the client a write outside any transaction was issued on, a client derived from the audited client (write mode: $mode)',
    async ({ mode }) => {
      const handles: unknown[] = [];
      const { audited, withContext } = createClient(mode, async (records, { handle, defaultWrite }) => {
        handles.push(handle);
        await defaultWrite(records);
      });
      const client = audited.$extends(nameEncoding);

      await withContext(() => audited.user.create({ data: { email: 'on-audited@example.com', name: 'A' } }));
      await withContext(() => client.user.create({ data: { email: 'on-derived@example.com', name: 'B' } }));
      await flushAllPendingWrites();

      // Compared by identity alone: a failing toBe would print the whole client
      expect(handles.map((handle) => [handle === audited, handle === client])).toEqual([
        [true, false],
        [false, true],
      ]);
    },
  );

  it('runs a write an extension continues through query inside a batch $transaction of the client passed to createAuditClient, and audits it', async () => {
    const { base, audited, withContext } = createClient('awaited');
    const client = audited.$extends({
      name: 'batched-with-a-statement',
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            const [, result] = await base.$transaction([base.$queryRaw`SELECT 1`, query(args)]);
            return result;
          },
        },
      },
    });

    const created = await withContext(() =>
      client.user.create({ data: { email: 'batched@example.com', name: 'Batched' } }),
    );

    expect(await raw.user.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ name: 'Batched' });
    expect(await auditLogsOfUser(created.id)).toEqual([
      { action: 'create', before: null, after: expect.objectContaining({ name: 'Batched' }) },
    ]);
  });

  it('rejects with AuditExtensionContinuationError, after the extension settles and writing nothing of it, an operation the extension replaces with another', async () => {
    const { audited, withContext } = createClient('awaited');
    const user = await withContext(() => audited.user.create({ data: { email: 'kept@example.com', name: 'Kept' } }));
    const client = audited.$extends({
      name: 'returns-without-deleting',
      query: {
        user: {
          async delete({ args }) {
            return raw.user.findUniqueOrThrow({ where: args.where });
          },
        },
      },
    });

    const error: unknown = await withContext(() => client.user.delete({ where: { id: user.id } })).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AuditExtensionContinuationError);
    expect(error).toMatchObject({
      extensionName: 'returns-without-deleting',
      modelName: 'User',
      operation: 'delete',
      violation: { kind: 'not-continued' },
    });
    expect(await raw.user.count({ where: { id: user.id } })).toBe(1);
    expect((await auditLogsOfUser(user.id)).map((log) => log.action)).toEqual(['create']);
  });

  describe('an extension that changes which relations a write writes, or how it continues it', () => {
    const fabricated = (id: string) => ({ id, email: 'kept@example.com', name: 'Fabricated' });

    const seeded = async () => {
      const client = createClient('awaited');
      const user = await client.withContext(() =>
        client.audited.user.create({ data: { email: 'kept@example.com', name: 'Kept' } }),
      );
      return { ...client, user };
    };

    const rejectionOf = async (pending: Promise<unknown>) => {
      const error: unknown = await pending.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(AuditExtensionContinuationError);
      return error;
    };

    const expectUnchanged = async (id: string) => {
      await flushAllPendingWrites();
      expect(await raw.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: 'Kept' });
      expect(await raw.post.count()).toBe(0);
      expect(await raw.profile.count()).toBe(0);
      expect((await auditLogsOfUser(id)).map((log) => log.action)).toEqual(['create']);
    };

    it('rejects, before it runs, a nested write the extension adds as a class instance', async () => {
      const { audited, withContext, user } = await seeded();
      class AddedPost {
        title = 'added as a class instance';
      }
      const client = audited.$extends({
        name: 'adds-post-instance',
        query: {
          user: {
            update({ args, query }) {
              return query({ ...args, data: { ...args.data, posts: { create: new AddedPost() } } });
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );

      expect(error).toMatchObject({
        extensionName: 'adds-post-instance',
        violation: { kind: 'structure', added: ['posts.create'], removed: [], changed: [] },
      });
      await expectUnchanged(user.id);
    });

    it('rejects, before it runs, a nested write the extension adds behind a toJSON', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends({
        name: 'adds-post-behind-toJSON',
        query: {
          user: {
            update({ args, query }) {
              return query({
                ...args,
                data: { ...args.data, posts: sentAs({ create: { title: 'added behind toJSON' } }) },
              });
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );

      expect(error).toMatchObject({ violation: { kind: 'structure', added: ['posts.create'] } });
      await expectUnchanged(user.id);
    });

    it('rejects, before it runs, a nested write the extension adds to the arguments once it has called query', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends({
        name: 'adds-post-after-query',
        query: {
          user: {
            update({ args, query }) {
              const data = { ...args.data };
              const pending = query({ ...args, data });
              Object.assign(data, { posts: { create: { title: 'added after query' } } });
              return pending;
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );

      expect(error).toMatchObject({ violation: { kind: 'structure', added: ['posts.create'] } });
      await expectUnchanged(user.id);
    });

    it('rejects, before it runs, an upsert whose nested write the extension moves from one branch to the other', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends({
        name: 'moves-post-to-update',
        query: {
          user: {
            upsert({ args, query }) {
              const { posts, ...create } = args.create;
              return query({ ...args, create, update: { ...args.update, posts } } as typeof args);
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() =>
          client.user.upsert({
            where: { email: 'new@example.com' },
            create: { email: 'new@example.com', name: 'New', posts: { create: { title: 'moved' } } },
            update: { name: 'Changed' },
          }),
        ),
      );

      expect(error).toMatchObject({
        violation: { kind: 'structure', added: ['update.posts.create'], removed: ['create.posts.create'], changed: [] },
      });
      expect(await raw.user.count()).toBe(1);
      await expectUnchanged(user.id);
    });

    it('rejects, before it runs, a write whose write in a branch of a nested upsert the extension moves to the other', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends({
        name: 'moves-avatar-to-update',
        query: {
          user: {
            update({ args, query }) {
              return query({
                ...args,
                data: {
                  ...args.data,
                  profile: {
                    upsert: {
                      create: { bio: 'created' },
                      update: { bio: 'updated', avatar: { create: { name: 'a' } } },
                    },
                  },
                },
              });
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() =>
          client.user.update({
            where: { id: user.id },
            data: {
              profile: {
                upsert: { create: { bio: 'created', avatar: { create: { name: 'a' } } }, update: { bio: 'updated' } },
              },
            },
          }),
        ),
      );

      expect(error).toMatchObject({
        violation: {
          kind: 'structure',
          added: ['profile.upsert[0].update.avatar.create'],
          removed: ['profile.upsert[0].create.avatar.create'],
          changed: [],
        },
      });
      await expectUnchanged(user.id);
    });

    it.each([
      { scope: 'outside any transaction, leaving the first write it ran unrecorded', inTransaction: false },
      { scope: 'in an interactive $transaction, rolling the first write back', inTransaction: true },
    ])('rejects a second call to query after a successful one, before it runs, $scope', async ({ inTransaction }) => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends({
        name: 'continues-twice',
        query: {
          user: {
            async update({ args, query }) {
              await query(args);
              return query({ ...args, data: { ...args.data, name: 'Twice' } });
            },
          },
        },
      });
      const update = (users: Pick<typeof client, 'user'>['user']) =>
        users.update({ where: { id: user.id }, data: { name: 'Changed' } });

      const error = await rejectionOf(
        withContext(() => (inTransaction ? client.$transaction((tx) => update(tx.user)) : update(client.user))),
      );
      await flushAllPendingWrites();

      expect(error).toMatchObject({ extensionName: 'continues-twice', violation: { kind: 'continued-twice' } });
      expect(await raw.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
        name: inTransaction ? 'Kept' : 'Changed',
      });
      expect((await auditLogsOfUser(user.id)).map((log) => log.action)).toEqual(['create']);
    });

    it('rejects the second of two concurrent calls to query before it runs', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends({
        name: 'continues-concurrently',
        query: {
          user: {
            async update({ args, query }) {
              const results = await Promise.allSettled([query(args), query(args)]);
              for (const result of results) {
                if (result.status === 'rejected') {
                  throw result.reason;
                }
              }
              return query(args);
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() =>
          client.$transaction((tx) => tx.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
        ),
      );

      expect(error).toMatchObject({ extensionName: 'continues-concurrently', violation: { kind: 'continued-twice' } });
      await expectUnchanged(user.id);
    });

    it('rejects a call to query the extension makes once it has settled, before it runs', async () => {
      const { audited, withContext, user } = await seeded();
      let late: Promise<unknown> | undefined;
      const client = audited.$extends({
        name: 'continues-late',
        query: {
          user: {
            async update({ args, query }) {
              late = new Promise((resolve) => {
                setTimeout(
                  () =>
                    resolve(
                      query(args).then(
                        () => undefined,
                        (reason: unknown) => reason,
                      ),
                    ),
                  0,
                );
              });
              return fabricated(user.id);
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );
      const lateError: unknown = await late;

      expect(error).toMatchObject({ extensionName: 'continues-late', violation: { kind: 'not-continued' } });
      expect(lateError).toBeInstanceOf(AuditExtensionContinuationError);
      expect(lateError).toMatchObject({
        extensionName: 'continues-late',
        violation: { kind: 'continued-after-settling' },
      });
      await expectUnchanged(user.id);
    });

    it('rejects a write whose failed attempt the extension swallows to return a result of its own', async () => {
      const { audited, withContext, user } = await seeded();
      await raw.user.create({ data: { email: 'taken@example.com', name: 'Taken' } });
      const client = audited.$extends({
        name: 'swallows-failure',
        query: {
          user: {
            async update({ args, query }) {
              try {
                return await query({ ...args, data: { ...args.data, email: 'taken@example.com' } });
              } catch {
                return fabricated(user.id);
              }
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );

      expect(error).toMatchObject({ extensionName: 'swallows-failure', violation: { kind: 'not-continued' } });
      await expectUnchanged(user.id);
    });

    it('names the second of two extensions when it replaces the operation', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited.$extends(nameEncoding).$extends({
        name: 'replaces',
        query: {
          user: {
            async update() {
              return fabricated(user.id);
            },
          },
        },
      });

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );

      expect(error).toMatchObject({ extensionName: 'replaces', violation: { kind: 'not-continued' } });
      await expectUnchanged(user.id);
    });

    it('names the first of two extensions when it adds a nested write', async () => {
      const { audited, withContext, user } = await seeded();
      const client = audited
        .$extends({
          name: 'adds-post',
          query: {
            user: {
              update({ args, query }) {
                return query({ ...args, data: { ...args.data, posts: { create: { title: 'added' } } } });
              },
            },
          },
        })
        .$extends(nameEncoding);

      const error = await rejectionOf(
        withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })),
      );

      expect(error).toMatchObject({
        extensionName: 'adds-post',
        violation: { kind: 'structure', added: ['posts.create'] },
      });
      await expectUnchanged(user.id);
    });
  });

  describe('an extension that changes values alone and continues the write once', () => {
    it('runs a write again after a failed attempt, and the audit records the write that ran', async () => {
      const { audited, withContext } = createClient('awaited');
      const user = await withContext(() => audited.user.create({ data: { email: 'kept@example.com', name: 'Kept' } }));
      await raw.user.create({ data: { email: 'taken@example.com', name: 'Taken' } });
      const client = audited.$extends({
        name: 'retries',
        query: {
          user: {
            async update({ args, query }) {
              try {
                return await query({ ...args, data: { ...args.data, email: 'taken@example.com' } });
              } catch {
                return query(args);
              }
            },
          },
        },
      });

      await withContext(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } }));

      expect(await raw.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
        email: 'kept@example.com',
        name: 'Changed',
      });
      expect(await auditLogsOfUser(user.id)).toEqual([
        { action: 'create', before: null, after: expect.objectContaining({ name: 'Kept' }) },
        {
          action: 'update',
          before: expect.objectContaining({ name: 'Kept' }),
          after: expect.objectContaining({ name: 'Changed' }),
        },
      ]);
    });

    it('runs a write a filter adds a field to the where of every nested update and connect of, and audits the posts', async () => {
      const { audited, withContext } = createClient('awaited');
      const [user, other] = await Promise.all([
        raw.user.create({ data: { email: 'kept@example.com', name: 'Kept' } }),
        raw.user.create({ data: { email: 'other@example.com', name: 'Other' } }),
      ]);
      const [renamed, moved] = await Promise.all([
        raw.post.create({ data: { title: 'Before', authorId: user.id } }),
        raw.post.create({ data: { title: 'Moved', authorId: other.id } }),
      ]);
      const unpublished = <T extends object>(where: T) => ({ ...where, published: false });
      const client = audited.$extends({
        name: 'unpublished-only',
        query: {
          user: {
            update({ args, query }) {
              const posts = args.data.posts;
              return query({
                ...args,
                data: {
                  ...args.data,
                  posts: {
                    update:
                      posts?.update && !Array.isArray(posts.update)
                        ? { ...posts.update, where: unpublished(posts.update.where) }
                        : posts?.update,
                    connect:
                      posts?.connect && !Array.isArray(posts.connect) ? unpublished(posts.connect) : posts?.connect,
                  },
                },
              });
            },
          },
        },
      });

      await withContext(() =>
        client.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: { where: { id: renamed.id }, data: { title: 'After' } },
              connect: { id: moved.id },
            },
          },
        }),
      );

      expect(
        await raw.post.findMany({ select: { id: true, title: true, authorId: true }, orderBy: { title: 'asc' } }),
      ).toEqual([
        { id: renamed.id, title: 'After', authorId: user.id },
        { id: moved.id, title: 'Moved', authorId: user.id },
      ]);
      const postLogs = await raw.auditLog.findMany({
        where: { entityType: 'Post' },
        select: { entityId: true, action: true },
      });
      expect(postLogs).toEqual(
        expect.arrayContaining([
          { entityId: renamed.id, action: 'update' },
          { entityId: moved.id, action: 'update' },
        ]),
      );
    });

    it('runs the write of an extension that changes its values in a batch $transaction, and audits it', async () => {
      const { audited, withContext } = createClient('awaited');
      const user = await withContext(() => audited.user.create({ data: { email: 'kept@example.com', name: 'Kept' } }));
      const client = audited.$extends(nameEncoding);

      await withContext(() =>
        client.$transaction([client.user.update({ where: { id: user.id }, data: { name: 'Changed' } })]),
      );

      expect(await raw.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ name: encode('Changed') });
      expect((await auditLogsOfUser(user.id)).at(-1)).toEqual({
        action: 'update',
        before: expect.objectContaining({ name: 'Kept' }),
        after: expect.objectContaining({ name: 'Changed' }),
      });
    });
  });

  it('audits a nested write the application passes behind a toJSON to the audited client', async () => {
    const { audited, withContext } = createClient('awaited');
    const user = await withContext(() => audited.user.create({ data: { email: 'kept@example.com', name: 'Kept' } }));

    await withContext(() =>
      audited.user.update({
        where: { id: user.id },
        data: { posts: sentAs({ create: { title: 'sent behind toJSON' } }) },
      }),
    );

    const post = await raw.post.findFirstOrThrow({ where: { authorId: user.id } });
    expect(post.title).toBe('sent behind toJSON');
    expect(
      await raw.auditLog.findMany({ where: { entityType: 'Post' }, select: { entityId: true, action: true } }),
    ).toEqual([{ entityId: post.id, action: 'create' }]);
  });
});
