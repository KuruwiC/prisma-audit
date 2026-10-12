/**
 * Integration Tests: Audit log rows written by nested and bulk writes
 *
 * Counts the audit log rows handed to `hooks.writer` for each scenario. Nothing here is timed.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, type TestContext } from './helpers/setup.js';

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

/** Create audit client with audit log row counter using hooks.writer */
const createAuditedClientWithAuditLogRowCounter = (
  basePrisma: PrismaClient,
  provider: AuditContextProvider,
  auditLogRowCount: { value: number },
) => {
  return createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    provider,
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
    fetchBefore: {
      update: false,
      delete: false,
    },
    hooks: {
      writer: async (records, { defaultWrite }) => {
        auditLogRowCount.value += records.length;
        await defaultWrite(records);
      },
    },
  });
};

const createAuditedClientFetchingBeforeState = (
  basePrisma: PrismaClient,
  provider: AuditContextProvider,
  auditLogRowCount: { value: number },
) => {
  return createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    provider,
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
    fetchBefore: {
      update: true,
      delete: true,
    },
    hooks: {
      writer: async (records, { defaultWrite }) => {
        auditLogRowCount.value += records.length;
        await defaultWrite(records);
      },
    },
  });
};

describe('Audit log rows by write shape', () => {
  let context: TestContext & { auditLogRowCount: { value: number } };

  beforeAll(async () => {
    const basePrisma = createBasePrisma();

    const provider = createAsyncLocalStorageProvider();
    const auditLogRowCount = { value: 0 };

    const prisma = createAuditedClientWithAuditLogRowCounter(basePrisma, provider, auditLogRowCount);

    context = {
      prisma,
      basePrisma,
      provider,
      auditLogRowCount,
    };
  });

  afterAll(async () => {
    await context.prisma.$disconnect();
    await context.basePrisma.$disconnect();
  });

  beforeEach(async () => {
    context.auditLogRowCount.value = 0;
    await cleanDatabase(context.prisma);
    context.auditLogRowCount.value = 0;
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('fetchBefore: false', () => {
    it('should write the User update and two rows per updated post for a nested update of three posts without pre-fetch', async () => {
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

      context.auditLogRowCount.value = 0;

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

      expect(context.auditLogRowCount.value).toBe(7);
    });

    it('should write the User update and two rows per deleted post for a nested delete of three posts without pre-fetch', async () => {
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

      context.auditLogRowCount.value = 0;

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

      // The User update, plus two rows per deleted post: each is recorded from the primary key its
      // WHERE names and the author key of the user it was deleted through, which resolve the
      // post's own root and its User.
      expect(context.auditLogRowCount.value).toBe(7);
    });
  });

  describe('Bulk Operations', () => {
    it('should write 2n + 1 audit log rows for a nested create of n posts, for n of 1, 5, 10 and 20', async () => {
      const counts = [1, 5, 10, 20];

      for (const count of counts) {
        context.auditLogRowCount.value = 0;

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

        expect(context.auditLogRowCount.value).toBe(2 * count + 1);
      }
    });

    it('should write the User update and two rows per post for a nested updateMany over 20 posts', async () => {
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

      context.auditLogRowCount.value = 0;

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

      expect(context.auditLogRowCount.value).toBe(41);
    });
  });

  describe('Interactive transaction', () => {
    it('should write the same audit log rows for a nested update inside and outside an interactive transaction', async () => {
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

      context.auditLogRowCount.value = 0;

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

      const auditLogsNoTx = context.auditLogRowCount.value;

      context.auditLogRowCount.value = 0;

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

      const auditLogsWithTx = context.auditLogRowCount.value;

      expect(auditLogsWithTx).toBe(auditLogsNoTx);
      expect(auditLogsNoTx).toBe(3);
    });
  });

  describe('Nested create under an update', () => {
    it('should write the User update and two rows for the post a nested create adds under a user update', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      context.auditLogRowCount.value = 0;

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

      expect(context.auditLogRowCount.value).toBe(3);
    });
  });
});

describe('Nested update with and without an include of the written relation', () => {
  let context: TestContext & { auditLogRowCount: { value: number } };

  beforeAll(async () => {
    const basePrisma = createBasePrisma();

    await basePrisma.$connect();

    const provider = createAsyncLocalStorageProvider();
    const auditLogRowCount = { value: 0 };

    const prisma = createAuditedClientFetchingBeforeState(basePrisma, provider, auditLogRowCount);

    context = {
      prisma,
      basePrisma,
      provider,
      auditLogRowCount,
    };
  });

  afterAll(async () => {
    await context.prisma.$disconnect();
    await context.basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
    context.auditLogRowCount.value = 0;
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('with fetchBefore: true', () => {
    it('audits a nested update when the caller does not include the written relation', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'no-include-test@example.com',
            name: 'No Include Test User',
            password: 'secret123',
            posts: {
              create: [{ title: 'Post 1', content: 'Content 1' }],
            },
          },
          include: { posts: true },
        });
      });

      const postId = user.posts[0].id;

      context.auditLogRowCount.value = 0;

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: { where: { id: postId }, data: { title: 'Updated without include' } },
            },
          },
        });
      });

      const auditLogsWithoutInclude = context.auditLogRowCount.value;

      // The post's update under its own aggregate and under its author; the user's columns did not change
      expect(auditLogsWithoutInclude).toBe(2);

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
      expect(auditLogs[0].after).toMatchObject({ title: 'Updated without include' });
      expect(auditLogs[0].before).toMatchObject({ title: 'Post 1' });
    });

    it('audits a nested update when the caller includes the written relation', async () => {
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

      context.auditLogRowCount.value = 0;

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

      const auditLogsWithInclude = context.auditLogRowCount.value;

      // The post's update under its own aggregate and under its author; the user's columns did not change
      expect(auditLogsWithInclude).toBe(2);

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
