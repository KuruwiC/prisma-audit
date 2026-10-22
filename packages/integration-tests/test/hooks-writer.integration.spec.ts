import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditLogData, EntityMap } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, flushAllPendingWrites, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, disposeTestContext, type TestContext } from './helpers/setup.js';

const testEntities: EntityMap = {
  User: defineEntity({
    type: 'User',
    excludeFields: ['updatedAt'],
  }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
};

const createAuditedClientWithWriterSpy = (
  basePrisma: PrismaClient,
  provider: AuditContextProvider,
  writerSpy: { callCount: number; calls: Array<{ logCount: number; contextId: string }> },
  config: {
    awaitWrite?: boolean;
    fetchBefore?: boolean;
  } = {},
) => {
  return createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    contextProvider: provider,
    entities: testEntities,
    diffing: {
      excludeFields: ['createdAt'],
    },
    security: {
      redact: {
        fields: [],
      },
    },
    performance: {
      awaitWrite: config.awaitWrite ?? true,
    },
    fetchBefore: {
      update: config.fetchBefore ?? false,
      delete: config.fetchBefore ?? false,
    },
    hooks: {
      writer: async (records: AuditLogData[], { auditContext, defaultWrite }) => {
        writerSpy.callCount++;
        writerSpy.calls.push({
          logCount: records.length,
          contextId: auditContext.actor.id,
        });
        await defaultWrite(records);
      },
    },
  });
};

describe('hooks.writer Coverage', () => {
  let context: TestContext & {
    writerSpy: { callCount: number; calls: Array<{ logCount: number; contextId: string }> };
  };

  beforeAll(async () => {
    const basePrisma = createBasePrisma();

    const provider = createAsyncLocalStorageProvider();
    const writerSpy = { callCount: 0, calls: [] as Array<{ logCount: number; contextId: string }> };

    const prisma = createAuditedClientWithWriterSpy(basePrisma, provider, writerSpy);

    context = {
      prisma,
      basePrisma,
      provider,
      writerSpy,
    };
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
    context.writerSpy.callCount = 0;
    context.writerSpy.calls = [];
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Synchronous Write Path (awaitWrite: true)', () => {
    it('should call hooks.writer for top-level create', async () => {
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls).toEqual([{ logCount: 1, contextId: 'test-user-1' }]);
    });

    it('should call hooks.writer for top-level update', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Reset spy after setup
      context.writerSpy.callCount = 0;
      context.writerSpy.calls = [];

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated User' },
        });
      });

      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls).toEqual([{ logCount: 1, contextId: 'test-user-1' }]);
    });

    it('should call hooks.writer for top-level delete', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Reset spy after setup
      context.writerSpy.callCount = 0;
      context.writerSpy.calls = [];

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: user.id },
        });
      });

      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls).toEqual([{ logCount: 1, contextId: 'test-user-1' }]);
    });

    it('should call hooks.writer for nested update', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            posts: {
              create: [{ title: 'Post 1', content: 'Content 1' }],
            },
          },
          include: { posts: true },
        });
      });

      // Reset spy after setup
      context.writerSpy.callCount = 0;
      context.writerSpy.calls = [];

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: {
                where: { id: user.posts[0].id },
                data: { title: 'Updated Post 1' },
              },
            },
          },
          include: { posts: true },
        });
      });

      // The user's update row plus the post's own row and its row under the User aggregate
      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls).toEqual([{ logCount: 3, contextId: 'test-user-1' }]);
    });
  });

  describe('Explicit Transaction Path ($transaction)', () => {
    it('should call hooks.writer once per operation for the creates of an explicit transaction', async () => {
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.create({
            data: {
              email: 'user1@example.com',
              name: 'User 1',
              password: 'secret123',
            },
          });

          await tx.user.create({
            data: {
              email: 'user2@example.com',
              name: 'User 2',
              password: 'secret123',
            },
          });
        });
      });

      expect(context.writerSpy.calls).toEqual([
        { logCount: 1, contextId: 'test-user-1' },
        { logCount: 1, contextId: 'test-user-1' },
      ]);
    });

    it('should call hooks.writer for nested operations inside transaction', async () => {
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.create({
            data: {
              email: 'user@example.com',
              name: 'User',
              password: 'secret123',
              posts: {
                create: [
                  { title: 'Post 1', content: 'Content 1' },
                  { title: 'Post 2', content: 'Content 2' },
                ],
              },
            },
            include: { posts: true },
          });
        });
      });

      // The user's row plus each post's own row and its row under the User aggregate
      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls).toEqual([{ logCount: 5, contextId: 'test-user-1' }]);
    });
  });

  describe('Asynchronous Write Path (awaitWrite: false)', () => {
    let asyncContext: TestContext & {
      writerSpy: { callCount: number; calls: Array<{ logCount: number; contextId: string }> };
    };

    beforeAll(async () => {
      const basePrisma = createBasePrisma();

      const provider = createAsyncLocalStorageProvider();
      const writerSpy = {
        callCount: 0,
        calls: [] as Array<{ logCount: number; contextId: string }>,
      };

      const prisma = createAuditedClientWithWriterSpy(basePrisma, provider, writerSpy, {
        awaitWrite: false, // Async writes
      });

      asyncContext = {
        prisma,
        basePrisma,
        provider,
        writerSpy,
      };
    });

    afterAll(async () => {
      await disposeTestContext(asyncContext);
    });

    beforeEach(async () => {
      await cleanDatabase(asyncContext.prisma);
      asyncContext.writerSpy.callCount = 0;
      asyncContext.writerSpy.calls = [];
    });

    it('should not call hooks.writer or persist audit logs when a deferred write is queued inside a transaction that then throws', async () => {
      const transactionPromise = asyncContext.provider.runAsync(testActor, async () => {
        return asyncContext.prisma.$transaction(async (tx: typeof asyncContext.prisma) => {
          await tx.user.create({
            data: {
              email: 'rollback-deferred@example.com',
              name: 'User',
              password: 'secret123',
            },
          });

          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      // Give any deferred write a chance to run before asserting it did not.
      await flushAllPendingWrites();

      expect(asyncContext.writerSpy.callCount).toBe(0);

      const auditLogs = await asyncContext.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it("should pass a nested create's rows to hooks.writer in a single call", async () => {
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            posts: {
              create: [
                { title: 'Post 1', content: 'Content 1' },
                { title: 'Post 2', content: 'Content 2' },
                { title: 'Post 3', content: 'Content 3' },
              ],
            },
          },
          include: { posts: true },
        });
      });

      // The user's row plus each post's own row and its row under the User aggregate
      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls).toEqual([{ logCount: 7, contextId: 'test-user-1' }]);
    });
  });

  describe('Multiple Contexts', () => {
    it('should call hooks.writer with correct context for each operation', async () => {
      const actor1: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'actor-1', name: 'Actor 1' },
      };
      const actor2: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'actor-2', name: 'Actor 2' },
      };

      await context.provider.runAsync(actor1, async () => {
        await context.prisma.user.create({
          data: {
            email: 'user1@example.com',
            name: 'User 1',
            password: 'secret123',
          },
        });
      });

      await context.provider.runAsync(actor2, async () => {
        await context.prisma.user.create({
          data: {
            email: 'user2@example.com',
            name: 'User 2',
            password: 'secret123',
          },
        });
      });

      expect(context.writerSpy.callCount).toBe(2);
      expect(context.writerSpy.calls[0]?.contextId).toBe('actor-1');
      expect(context.writerSpy.calls[1]?.contextId).toBe('actor-2');
    });
  });

  describe("the writer's database handle", () => {
    const openClients: Array<{ $disconnect: () => Promise<void> }> = [];

    afterEach(async () => {
      for (const client of openClients.splice(0)) {
        await client.$disconnect();
      }
    });

    /**
     * An audited client whose writer creates, through the handle it receives, one Tag named after
     * each audited user's email, then writes the audit logs with the default write
     */
    const createClient = (awaitWrite: boolean) => {
      const basePrisma = createBasePrisma();
      const handles: unknown[] = [];
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: context.provider,
        entities: testEntities,
        performance: { awaitWrite },
        hooks: {
          writer: async (records, { handle, defaultWrite }) => {
            handles.push(handle);
            for (const record of records) {
              if (record.entityType === 'User' && record.aggregateType === 'User') {
                const { email } = record.after as { email: string };
                await handle.tag.create({ data: { name: `writer:${email}` } });
              }
            }
            await defaultWrite(records);
          },
        },
      });
      openClients.push(prisma, basePrisma);
      return { basePrisma, prisma, handles };
    };

    const createUser = (client: { user: PrismaClient['user'] }, email: string) =>
      client.user.create({ data: { email, name: 'User', password: 'secret123' } });

    const tagNames = async () =>
      (await context.basePrisma.tag.findMany({ orderBy: { name: 'asc' } })).map((tag) => tag.name);

    it('is the transaction client for an awaited write: what the writer writes through it commits and rolls back with the operation', async () => {
      const { prisma } = createClient(true);

      await context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await createUser(tx, 'kept@example.com');
        }),
      );
      const rolledBack = context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await createUser(tx, 'undone@example.com');
          throw new Error('Rollback test');
        }),
      );

      await expect(rolledBack).rejects.toThrow('Rollback test');
      expect(await tagNames()).toEqual(['writer:kept@example.com']);
    });

    it('is the base client for a detached write', async () => {
      const { basePrisma, prisma, handles } = createClient(false);

      await context.provider.runAsync(testActor, () => createUser(prisma, 'detached@example.com'));
      await flushAllPendingWrites();

      expect(handles).toHaveLength(1);
      // Compared by identity: a client does not print as a diff.
      expect(handles[0] === basePrisma).toBe(true);
      expect(await tagNames()).toEqual(['writer:detached@example.com']);
    });

    it('is the base client for a write queued until the transaction commits', async () => {
      const { basePrisma, prisma, handles } = createClient(false);

      await context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await createUser(tx, 'after-commit@example.com');
        }),
      );
      await flushAllPendingWrites();

      expect(handles).toHaveLength(1);
      // Compared by identity: a client does not print as a diff.
      expect(handles[0] === basePrisma).toBe(true);
      expect(await tagNames()).toEqual(['writer:after-commit@example.com']);
    });
  });

  describe("the writer's transaction flag", () => {
    const openClients: Array<{ $disconnect: () => Promise<void> }> = [];

    afterEach(async () => {
      for (const client of openClients.splice(0)) {
        await client.$disconnect();
      }
    });

    const createClient = (awaitWrite: boolean, openImplicitTransaction = false) => {
      const basePrisma = createBasePrisma();
      const flags: boolean[] = [];
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: context.provider,
        entities: testEntities,
        performance: { awaitWrite, openImplicitTransaction },
        hooks: {
          writer: async (records, { inTransaction, defaultWrite }) => {
            flags.push(inTransaction);
            await defaultWrite(records);
          },
        },
      });
      openClients.push(prisma, basePrisma);
      return { prisma, flags };
    };

    const createUser = (client: { user: PrismaClient['user'] }, email: string) =>
      client.user.create({ data: { email, name: 'User', password: 'secret123' } });

    it("is true for an awaited write in the caller's transaction", async () => {
      const { prisma, flags } = createClient(true);

      await context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await createUser(tx, 'in-transaction@example.com');
        }),
      );

      expect(flags).toEqual([true]);
    });

    it('is true for an awaited write in the transaction the client opens around the operation with openImplicitTransaction', async () => {
      const { prisma, flags } = createClient(true, true);

      await context.provider.runAsync(testActor, () => createUser(prisma, 'implicit-transaction@example.com'));

      expect(flags).toEqual([true]);
    });

    it('is false for an awaited write outside any transaction, written once the operation has committed', async () => {
      const { prisma, flags } = createClient(true);

      await context.provider.runAsync(testActor, () => createUser(prisma, 'after-commit@example.com'));

      expect(flags).toEqual([false]);
    });

    it('is false for a detached write', async () => {
      const { prisma, flags } = createClient(false);

      await context.provider.runAsync(testActor, () => createUser(prisma, 'detached@example.com'));
      await flushAllPendingWrites();

      expect(flags).toEqual([false]);
    });

    it('is false for a write queued until the transaction commits', async () => {
      const { prisma, flags } = createClient(false);

      await context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await createUser(tx, 'after-commit@example.com');
        }),
      );
      await flushAllPendingWrites();

      expect(flags).toEqual([false]);
    });
  });
});
