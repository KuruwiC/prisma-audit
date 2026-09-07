/**
 * Integration Tests: Performance Benchmarks
 */

import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase, type TestContext } from './helpers/setup.js';

const testAggregateMapping: AggregateMapping = {
  User: defineEntity({
    type: 'User',
    excludeFields: ['updatedAt'],
  }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
  Comment: defineEntity({
    type: 'Comment',
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
  }),
};

/** Create audit client with audit log write counter using hooks.writer */
const createAuditedClientWithAuditLogWriteCounter = (
  basePrisma: PrismaClient,
  provider: AuditContextProvider,
  auditLogWriteCount: { value: number },
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
      awaitWrite: true,
    },
    nestedOperations: {
      update: { fetchBeforeOperation: false },
      delete: { fetchBeforeOperation: false },
    },
    hooks: {
      writer: async (logs, _context, defaultWrite) => {
        auditLogWriteCount.value += logs.length;
        await defaultWrite(logs);
      },
    },
  });
};

/** Create audit client with fetchBeforeOperation: true for refetch fallback tests */
const createAuditedClientWithRefetchFallback = (
  basePrisma: PrismaClient,
  provider: AuditContextProvider,
  auditLogWriteCount: { value: number },
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
      awaitWrite: true,
    },
    nestedOperations: {
      update: { fetchBeforeOperation: true },
      delete: { fetchBeforeOperation: true },
    },
    hooks: {
      writer: async (logs, _context, defaultWrite) => {
        auditLogWriteCount.value += logs.length;
        await defaultWrite(logs);
      },
    },
  });
};

describe('Performance Benchmarks', () => {
  let context: TestContext & { auditLogWriteCount: { value: number } };

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');

    const basePrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });

    const provider = createAsyncLocalStorageProvider();
    const auditLogWriteCount = { value: 0 };

    const prisma = createAuditedClientWithAuditLogWriteCounter(basePrisma, provider, auditLogWriteCount);

    context = {
      prisma,
      basePrisma,
      provider,
      databaseUrl,
      auditLogWriteCount,
    };
  });

  afterAll(async () => {
    try {
      await context.prisma.$disconnect();
    } catch (error) {
      console.error('Error disconnecting Prisma:', error);
    }
  });

  beforeEach(async () => {
    context.auditLogWriteCount.value = 0;
    await cleanDatabase(context.prisma);
    context.auditLogWriteCount.value = 0;
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Baseline Performance', () => {
    it('should write N audit log rows for N nested creates', async () => {
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

      console.log(`Nested create: ${context.auditLogWriteCount.value} audit logs`);
      expect(context.auditLogWriteCount.value).toBeGreaterThan(0);
      expect(context.auditLogWriteCount.value).toBe(7);
    });
  });

  describe('fetchBeforeOperation: false', () => {
    it('should minimize audit log writes for nested update without pre-fetch', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
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

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: user.posts.map((post: { id: string; title: string }) => ({
                where: { id: post.id },
                data: { title: `${post.title} - Updated` },
              })),
            },
          },
          include: { posts: true },
        });
      });

      console.log(`Nested update (no pre-fetch): ${context.auditLogWriteCount.value} audit logs`);
      expect(context.auditLogWriteCount.value).toBeGreaterThan(0);
      expect(context.auditLogWriteCount.value).toBe(7);
    });

    it('should minimize audit log writes for nested delete without pre-fetch', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
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

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              delete: user.posts.map((post: { id: string }) => ({ id: post.id })),
            },
          },
          include: { posts: true },
        });
      });

      console.log(`Nested delete (no pre-fetch): ${context.auditLogWriteCount.value} audit logs`);
      expect(context.auditLogWriteCount.value).toBeGreaterThan(0);
      expect(context.auditLogWriteCount.value).toBe(1);
    });
  });

  describe('Bulk Operations', () => {
    it('should demonstrate scalability of nested creates', async () => {
      const counts = [1, 5, 10, 20];
      const results: { count: number; auditLogs: number }[] = [];

      for (const count of counts) {
        context.auditLogWriteCount.value = 0;

        await context.provider.runAsync(testActor, async () => {
          await context.prisma.user.create({
            data: {
              email: `user-${count}@example.com`,
              name: `User ${count}`,
              password: 'secret123',
              posts: {
                create: Array.from({ length: count }, (_, i) => ({
                  title: `Post ${i + 1}`,
                  content: `Content ${i + 1}`,
                })),
              },
            },
            include: { posts: true },
          });
        });

        results.push({ count, auditLogs: context.auditLogWriteCount.value });
        console.log(
          `${count} nested creates: ${context.auditLogWriteCount.value} audit logs (1 user + ${count} posts + ${count} aggregate logs)`,
        );
      }

      for (let i = 0; i < results.length; i++) {
        expect(results[i]?.auditLogs).toBe(2 * (results[i]?.count ?? 0) + 1);
      }

      for (let i = 1; i < results.length; i++) {
        expect(results[i]?.auditLogs ?? 0).toBeGreaterThan(results[i - 1]?.auditLogs ?? 0);
      }
    });

    it('should measure updateMany performance', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            posts: {
              create: Array.from({ length: 20 }, (_, i) => ({
                title: `Post ${i + 1}`,
                content: `Content ${i + 1}`,
                published: false,
              })),
            },
          },
          include: { posts: true },
        });
      });

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              updateMany: {
                where: { published: false },
                data: { published: true },
              },
            },
          },
          include: { posts: true },
        });
      });

      console.log(`updateMany (20 posts): ${context.auditLogWriteCount.value} audit logs`);
      expect(context.auditLogWriteCount.value).toBeGreaterThan(0);
      expect(context.auditLogWriteCount.value).toBe(41);
    });
  });

  describe('Transaction Overhead', () => {
    it('should measure audit log count difference with/without transaction', async () => {
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

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: { where: { id: user.posts[0].id }, data: { title: 'Updated 1' } },
            },
          },
          include: { posts: true },
        });
      });

      const auditLogsNoTx = context.auditLogWriteCount.value;
      console.log(`Without transaction: ${auditLogsNoTx} audit logs`);

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.update({
            where: { id: user.id },
            data: {
              posts: {
                update: { where: { id: user.posts[0].id }, data: { title: 'Updated 2' } },
              },
            },
            include: { posts: true },
          });
        });
      });

      const auditLogsWithTx = context.auditLogWriteCount.value;
      console.log(`With transaction: ${auditLogsWithTx} audit logs`);

      expect(auditLogsNoTx).toBeGreaterThan(0);
      expect(auditLogsWithTx).toBe(auditLogsNoTx);
      expect(auditLogsNoTx).toBe(3);
    });
  });

  describe('Comparison: Include vs Pre-fetch', () => {
    it('should compare audit log count for create with include vs update without pre-fetch', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              create: { title: 'Post 1', content: 'Content 1' },
            },
          },
          include: { posts: true },
        });
      });

      const auditLogsCreate = context.auditLogWriteCount.value;
      console.log(`Create with include: ${auditLogsCreate} audit logs`);

      const post = await context.prisma.post.findFirst({ where: { authorId: user.id } });
      if (!post) throw new Error('Post not found');

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: { where: { id: post.id }, data: { title: 'Updated Post 1' } },
            },
          },
          include: { posts: true },
        });
      });

      const auditLogsUpdate = context.auditLogWriteCount.value;
      console.log(`Update without pre-fetch: ${auditLogsUpdate} audit logs`);

      expect(auditLogsCreate).toBeGreaterThan(0);
      expect(auditLogsUpdate).toBeGreaterThan(0);
      expect(auditLogsCreate).toBe(3);
      expect(auditLogsUpdate).toBe(3);
    });
  });
});

describe('Refetch Fallback Mechanism', () => {
  let context: TestContext & { auditLogWriteCount: { value: number } };

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');

    const basePrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });

    await basePrisma.$connect();

    const provider = createAsyncLocalStorageProvider();
    const auditLogWriteCount = { value: 0 };

    const prisma = createAuditedClientWithRefetchFallback(basePrisma, provider, auditLogWriteCount);

    context = {
      prisma,
      basePrisma,
      provider,
      auditLogWriteCount,
      databaseUrl,
    };
  });

  afterAll(async () => {
    if (context?.prisma) {
      await context.prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
    context.auditLogWriteCount.value = 0;
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('with fetchBeforeOperation: true', () => {
    it('should automatically refetch nested records when include is missing', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'refetch-test@example.com',
            name: 'Refetch Test User',
            password: 'secret123',
            posts: {
              create: [{ title: 'Post 1', content: 'Content 1' }],
            },
          },
          include: { posts: true },
        });
      });

      const postId = user.posts[0].id;

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: { where: { id: postId }, data: { title: 'Updated via Refetch' } },
            },
          },
        });
      });

      const auditLogsWithRefetch = context.auditLogWriteCount.value;
      console.log(`Update without include (refetch fallback): ${auditLogsWithRefetch} audit logs`);

      expect(auditLogsWithRefetch).toBeGreaterThan(0);
      expect(auditLogsWithRefetch).toBe(3);

      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: postId,
          action: 'update',
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].after).toMatchObject({ title: 'Updated via Refetch' });
      expect(auditLogs[0].before).toMatchObject({ title: 'Post 1' });
    });

    it('should use include data when available', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'include-test@example.com',
            name: 'Include Test User',
            password: 'secret123',
            posts: {
              create: [{ title: 'Post 2', content: 'Content 2' }],
            },
          },
          include: { posts: true },
        });
      });

      const postId = user.posts[0].id;

      context.auditLogWriteCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: { where: { id: postId }, data: { title: 'Updated via Include' } },
            },
          },
          include: { posts: true },
        });
      });

      const auditLogsWithInclude = context.auditLogWriteCount.value;
      console.log(`Update with include (no refetch): ${auditLogsWithInclude} audit logs`);

      expect(auditLogsWithInclude).toBe(3);

      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: postId,
          action: 'update',
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].after).toMatchObject({ title: 'Updated via Include' });
    });
  });
});
