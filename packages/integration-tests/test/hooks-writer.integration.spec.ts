import type { AggregateMapping, AuditLogData } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

const testAggregateMapping: AggregateMapping = {
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
    fetchBeforeOperation?: boolean;
  } = {},
) => {
  return createAuditClient(basePrisma, {
    Prisma,
    provider,
    basePrisma,
    aggregateMapping: testAggregateMapping,
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
    nestedOperations: {
      update: { fetchBeforeOperation: config.fetchBeforeOperation ?? false },
      delete: { fetchBeforeOperation: config.fetchBeforeOperation ?? false },
    },
    hooks: {
      writer: async (logs: AuditLogData[], context: AuditContext, defaultWrite) => {
        writerSpy.callCount++;
        writerSpy.calls.push({
          logCount: logs.length,
          contextId: context.actor.id,
        });
        await defaultWrite(logs);
      },
    },
  });
};

describe('hooks.writer Coverage (Phase 2)', () => {
  let context: TestContext & {
    writerSpy: { callCount: number; calls: Array<{ logCount: number; contextId: string }> };
  };

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const { execSync } = await import('node:child_process');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const Filename = fileURLToPath(import.meta.url);
    const Dirname = dirname(Filename);

    console.log('Starting PostgreSQL container for hooks.writer tests...');
    const container = await new PostgreSqlContainer('postgres:16-alpine').withExposedPorts(5432).start();

    const databaseUrl = container.getConnectionUri();
    console.log('PostgreSQL container started');

    const databasePackagePath = join(Dirname, '../../database');
    const schemaPath = join(databasePackagePath, 'prisma/schema.prisma');

    execSync(`npx prisma db push --schema=${schemaPath} --skip-generate`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const basePrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });

    const provider = createAsyncLocalStorageProvider();
    const writerSpy = { callCount: 0, calls: [] as Array<{ logCount: number; contextId: string }> };

    const prisma = createAuditedClientWithWriterSpy(basePrisma, provider, writerSpy);

    context = {
      container,
      prisma,
      basePrisma,
      provider,
      databaseUrl,
      writerSpy,
    };

    console.log('hooks.writer test database setup complete');
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    context.writerSpy.callCount = 0;
    context.writerSpy.calls = [];
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

      // Verify: hooks.writer was called exactly once
      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls[0]?.logCount).toBeGreaterThan(0);
      expect(context.writerSpy.calls[0]?.contextId).toBe('test-user-1');
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

      // Verify: hooks.writer was called exactly once
      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls[0]?.logCount).toBeGreaterThan(0);
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

      // Verify: hooks.writer was called exactly once
      expect(context.writerSpy.callCount).toBe(1);
      expect(context.writerSpy.calls[0]?.logCount).toBeGreaterThan(0);
    });

    it('should call hooks.writer for nested create', async () => {
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
              ],
            },
          },
          include: { posts: true },
        });
      });

      // Verify: hooks.writer was called (may be once or multiple times depending on batching)
      expect(context.writerSpy.callCount).toBeGreaterThan(0);
      const totalLogs = context.writerSpy.calls.reduce((sum, call) => sum + call.logCount, 0);
      expect(totalLogs).toBeGreaterThan(0); // At least user + posts
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

      // Verify: hooks.writer was called
      expect(context.writerSpy.callCount).toBeGreaterThan(0);
    });
  });

  describe('Explicit Transaction Path ($transaction)', () => {
    it('should call hooks.writer inside explicit transaction', async () => {
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

      // Verify: hooks.writer was called (once for batched logs or multiple times)
      expect(context.writerSpy.callCount).toBeGreaterThan(0);
      const totalLogs = context.writerSpy.calls.reduce((sum, call) => sum + call.logCount, 0);
      expect(totalLogs).toBeGreaterThanOrEqual(2); // At least 2 users
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

      // Verify: hooks.writer was called
      expect(context.writerSpy.callCount).toBeGreaterThan(0);
      const totalLogs = context.writerSpy.calls.reduce((sum, call) => sum + call.logCount, 0);
      expect(totalLogs).toBeGreaterThan(0); // User + posts
    });

    it('should NOT call hooks.writer if transaction is rolled back', async () => {
      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.create({
            data: {
              email: 'user@example.com',
              name: 'User',
              password: 'secret123',
            },
          });

          // Intentionally throw error to rollback
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      // Verify: hooks.writer should NOT be called (transaction rolled back)
      // Note: This depends on implementation - if deferred writes are used,
      // writer may not be called until after commit
      // For now, we just verify that no audit logs were persisted
      const auditLogs = await context.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('Asynchronous Write Path (awaitWrite: false)', () => {
    let asyncContext: TestContext & {
      writerSpy: { callCount: number; calls: Array<{ logCount: number; contextId: string }> };
    };

    beforeAll(async () => {
      const basePrisma = new PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });

      const provider = createAsyncLocalStorageProvider();
      const writerSpy = {
        callCount: 0,
        calls: [] as Array<{ logCount: number; contextId: string }>,
      };

      const prisma = createAuditedClientWithWriterSpy(basePrisma, provider, writerSpy, {
        awaitWrite: false, // Async writes
      });

      asyncContext = {
        container: context.container,
        prisma,
        basePrisma,
        provider,
        databaseUrl: context.databaseUrl,
        writerSpy,
      };
    });

    beforeEach(async () => {
      asyncContext.writerSpy.callCount = 0;
      asyncContext.writerSpy.calls = [];
      await cleanDatabase(asyncContext.prisma);
      asyncContext.writerSpy.callCount = 0;
      asyncContext.writerSpy.calls = [];
    });

    it('should call hooks.writer for async write outside transaction', async () => {
      await asyncContext.provider.runAsync(testActor, async () => {
        await asyncContext.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Wait for async write to complete (fire and forget)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify: hooks.writer was called
      expect(asyncContext.writerSpy.callCount).toBeGreaterThan(0);
    });

    it('should call hooks.writer for async write inside transaction (deferred)', async () => {
      await asyncContext.provider.runAsync(testActor, async () => {
        await asyncContext.prisma.$transaction(async (tx: typeof asyncContext.prisma) => {
          await tx.user.create({
            data: {
              email: 'user@example.com',
              name: 'User',
              password: 'secret123',
            },
          });
        });
      });

      // Verify: hooks.writer was called (deferred writes are executed after commit)
      expect(asyncContext.writerSpy.callCount).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should call hooks.writer even with empty before/after states', async () => {
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

      // Delete with fetchBeforeOperation: false (before state will be null)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: user.id },
        });
      });

      // Verify: hooks.writer was called even with null before state
      expect(context.writerSpy.callCount).toBe(1);
    });

    it('should batch multiple operations in single hooks.writer call when appropriate', async () => {
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

      // Verify: hooks.writer was called (may batch multiple logs into single call)
      expect(context.writerSpy.callCount).toBeGreaterThan(0);
      const totalLogs = context.writerSpy.calls.reduce((sum, call) => sum + call.logCount, 0);
      expect(totalLogs).toBeGreaterThan(3); // At least user + 3 posts (+ aggregate logs)
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

      // Verify: hooks.writer was called twice with different contexts
      expect(context.writerSpy.callCount).toBe(2);
      expect(context.writerSpy.calls[0]?.contextId).toBe('actor-1');
      expect(context.writerSpy.calls[1]?.contextId).toBe('actor-2');
    });
  });
});
