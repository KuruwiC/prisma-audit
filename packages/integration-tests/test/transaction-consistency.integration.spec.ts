/**
 * Integration Tests: Transaction Consistency
 *
 * Verifies that enrichers and idResolvers see uncommitted changes within transactions.
 *
 * @see https://github.com/prisma/prisma/discussions/20554
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Transaction Consistency Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  describe('Actor enricher transaction consistency', () => {
    it('should enrich actor context without database query', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'actor-1',
          name: 'Test Actor',
        },
      };

      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'Test User',
            password: 'secret123',
          },
        });
      });

      const userLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      expect(userLogs).toHaveLength(1);
      const userLog = userLogs[0];

      expect(userLog.actorContext).toBeDefined();
      const actorContext = userLog.actorContext as Record<string, unknown>;
      expect(actorContext.name).toBe('Test Actor');
    });
  });

  describe('IdResolver transaction consistency', () => {
    it('should resolve ID using uncommitted data within transaction', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'actor-1',
        },
      };

      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          // Create user within transaction
          const user = await tx.user.create({
            data: {
              email: 'user@example.com',
              name: 'User',
              password: 'secret123',
            },
          });

          await tx.user.update({
            where: { id: user.id },
            data: { email: 'updated@example.com' },
          });

          await tx.post.create({
            data: {
              title: 'Test Post',
              content: 'Content',
              authorId: user.id,
            },
          });
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post' },
      });

      expect(postLogs).toHaveLength(2);

      const aggregateTypes = postLogs.map((log: { aggregateType: string }) => log.aggregateType).sort();
      expect(aggregateTypes).toEqual(['Post', 'User']);
    });
  });

  describe('Aggregate root resolution transaction consistency', () => {
    it('should resolve aggregate roots using uncommitted data', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'actor-1',
        },
      };

      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          // Create user within transaction
          const user = await tx.user.create({
            data: {
              email: 'user@example.com',
              name: 'User',
              password: 'secret123',
            },
          });

          await tx.post.create({
            data: {
              title: 'Test Post',
              content: 'Content',
              authorId: user.id,
            },
          });
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post' },
      });

      expect(postLogs).toHaveLength(2);

      const userAggregateLog = postLogs.find((log: { aggregateType: string }) => log.aggregateType === 'User');
      expect(userAggregateLog).toBeDefined();
      expect(userAggregateLog?.aggregateId).toBeDefined();

      const postAggregateLog = postLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(postAggregateLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBeDefined();
    });
  });

  describe('RefetchNestedRecords transaction consistency', () => {
    it('should refetch nested records using transactional client', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'actor-1',
        },
      };

      const user = await context.provider.runAsync(auditContext, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            posts: {
              create: {
                title: 'Old Title',
                content: 'Content',
              },
            },
          },
          include: {
            posts: true,
          },
        });
      });

      const postId = user.posts[0].id;

      await context.prisma.auditLog.deleteMany({});

      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.post.update({
            where: { id: postId },
            data: { title: 'New Title' },
          });

          await tx.user.update({
            where: { id: user.id },
            data: {
              name: 'Updated User',
              posts: {
                update: {
                  where: { id: postId },
                  data: { content: 'Updated content' },
                },
              },
            },
          });
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'update' },
        orderBy: { createdAt: 'asc' },
      });

      expect(postLogs.length).toBeGreaterThanOrEqual(1);

      const nestedUpdateLog = postLogs[postLogs.length - 1];
      expect(nestedUpdateLog.before).toBeDefined();
      const before = nestedUpdateLog.before as Record<string, unknown>;

      expect(before.title).toBe('New Title');
    });
  });
});
