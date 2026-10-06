/**
 * Tag-based Performance Strategies E2E Tests
 */

import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineAggregateMapping,
  defineEntity,
  flushAllPendingWrites,
  foreignKey,
  type PrismaModelNames,
  to,
} from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './test-helpers.js';

describe('Tag-based Strategies E2E', () => {
  let basePrisma: PrismaClient;
  const auditProvider = createAsyncLocalStorageProvider();

  beforeEach(async () => {
    basePrisma = new PrismaClient();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await basePrisma.$disconnect();
  });

  describe('awaitWriteIf with database operations', () => {
    it('should write audit log synchronously for critical tagged models', async () => {
      const aggregateMapping = defineAggregateMapping<PrismaModelNames<PrismaClient>, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
          tags: ['critical', 'pii'],
        }),
      });

      const awaitWriteIfSpy = vi.fn((_modelName: string, tags: string[]) => {
        return tags.includes('critical');
      });

      const prisma = createAuditClient(basePrisma, {
        provider: auditProvider,
        aggregateMapping,
        performance: {
          awaitWrite: false,
          awaitWriteIf: awaitWriteIfSpy,
        },
        Prisma,
      });
      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-actor-1' },
        },
        async () => {
          await prisma.user.create({
            data: {
              email: 'critical-user@example.com',
              name: 'Critical User',
            },
          });
        },
      );

      const auditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]?.action).toBe('create');
      expect(auditLogs[0]?.entityCategory).toBe('model');
      expect(awaitWriteIfSpy).toHaveBeenCalledWith('User', ['critical', 'pii']);
    });

    it('should write audit log asynchronously for non-critical tagged models', async () => {
      const aggregateMapping = defineAggregateMapping<PrismaModelNames<PrismaClient>, PrismaClient>()({
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
          tags: ['analytics', 'non-critical'],
        }),
      });

      const awaitWriteIfSpy = vi.fn((_modelName: string, tags: string[]) => {
        return tags.includes('critical');
      });

      const prisma = createAuditClient(basePrisma, {
        provider: auditProvider,
        aggregateMapping,
        performance: {
          awaitWrite: false,
          awaitWriteIf: awaitWriteIfSpy,
        },
        Prisma,
      });

      // Create a user first
      const user = await basePrisma.user.create({
        data: {
          email: 'author@example.com',
          name: 'Author',
        },
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: user.id },
        },
        async () => {
          await prisma.post.create({
            data: {
              title: 'Test Post',
              content: 'Test Content',
              published: false,
              authorId: user.id,
            },
          });
        },
      );

      const auditLogs = await waitFor(
        async () =>
          basePrisma.auditLog.findMany({
            where: { entityType: 'Post' },
          }),
        { timeout: 2000, interval: 50, checkFn: (logs) => logs.length > 0 },
      );

      expect(auditLogs.map((log) => log.aggregateType).sort()).toEqual(['Post', 'User']);
      expect(awaitWriteIfSpy).toHaveBeenCalledWith('Post', ['analytics', 'non-critical']);
    });
  });

  describe('samplingIf with database operations', () => {
    it('should apply 100% sampling for financial tagged models', async () => {
      const aggregateMapping = defineAggregateMapping<PrismaModelNames<PrismaClient>, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
          tags: ['financial', 'critical'],
        }),
      });

      const samplingIfSpy = vi.fn((_modelName: string, tags: string[]) => {
        return tags.includes('financial') ? 1.0 : 0.0;
      });

      const prisma = createAuditClient(basePrisma, {
        provider: auditProvider,
        aggregateMapping,
        performance: {
          sampling: 0.5,
          samplingIf: samplingIfSpy,
          awaitWrite: true, // Ensure synchronous for testing
        },
        Prisma,
      });

      // Create multiple users
      const createOperations = Array.from({ length: 10 }, (_, i) =>
        auditProvider.runAsync(
          {
            actor: { category: 'system', type: 'System', id: 'test-system' },
          },
          async () => {
            await prisma.user.create({
              data: {
                email: `financial-user-${i}@example.com`,
                name: `Financial User ${i}`,
              },
            });
          },
        ),
      );

      await Promise.all(createOperations);

      // With 100% sampling, all operations should be logged
      const auditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      expect(auditLogs).toHaveLength(10);
      expect(samplingIfSpy).toHaveBeenCalledWith('User', ['financial', 'critical']);
    });

    it('should apply reduced sampling rate for analytics tagged models', async () => {
      const aggregateMapping = defineAggregateMapping<PrismaModelNames<PrismaClient>, PrismaClient>()({
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
          tags: ['analytics', 'high-volume'],
        }),
      });
      let callCount = 0;
      const samplingIfSpy = vi.fn((_modelName: string, tags: string[]) => {
        if (!tags.includes('analytics')) {
          return 1.0;
        }
        callCount++;
        return callCount % 3 === 0 ? 1.0 : 0.0;
      });

      const prisma = createAuditClient(basePrisma, {
        provider: auditProvider,
        aggregateMapping,
        performance: {
          sampling: 1.0, // Global default (overridden by samplingIf)
          samplingIf: samplingIfSpy,
          awaitWrite: true,
        },
        Prisma,
      });

      const user = await basePrisma.user.create({
        data: {
          email: 'author@example.com',
          name: 'Author',
        },
      });

      const operationCount = 9;
      for (let i = 0; i < operationCount; i++) {
        await auditProvider.runAsync(
          {
            actor: { category: 'user', type: 'User', id: user.id },
          },
          async () => {
            await prisma.post.create({
              data: {
                title: `Analytics Post ${i}`,
                content: `Content ${i}`,
                published: false,
                authorId: user.id,
              },
            });
          },
        );
      }

      const auditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'Post' },
      });

      // Every third Post create is sampled in, and each one writes a Post row and a User aggregate row
      const sampledInCreates = operationCount / 3;
      expect(auditLogs.filter((log) => log.aggregateType === 'Post')).toHaveLength(sampledInCreates);
      expect(auditLogs.filter((log) => log.aggregateType === 'User')).toHaveLength(sampledInCreates);
      expect(auditLogs).toHaveLength(sampledInCreates * 2);
      expect(samplingIfSpy).toHaveBeenCalledTimes(operationCount);
      expect(samplingIfSpy).toHaveBeenCalledWith('Post', ['analytics', 'high-volume']);
    });
  });

  describe('Combined tag-based strategies in transactions', () => {
    it('should apply different strategies to different models in same transaction', async () => {
      const aggregateMapping = defineAggregateMapping<PrismaModelNames<PrismaClient>, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
          tags: ['critical', 'pii'],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
          tags: ['user-content', 'moderate-volume'],
        }),
      });

      const awaitWriteIfSpy = vi.fn((_modelName: string, tags: string[]) => {
        return tags.includes('critical');
      });

      const samplingIfSpy = vi.fn((_modelName: string, tags: string[]) => {
        if (tags.includes('critical')) return 1.0;
        if (tags.includes('moderate-volume')) return 0.5;
        return 1.0;
      });

      const prisma = createAuditClient(basePrisma, {
        provider: auditProvider,
        aggregateMapping,
        performance: {
          awaitWrite: false,
          awaitWriteIf: awaitWriteIfSpy,
          sampling: 1.0,
          samplingIf: samplingIfSpy,
        },
        Prisma,
      });

      // Below the 0.5 rate of the moderate-volume Post: its write is sampled in
      vi.spyOn(Math, 'random').mockReturnValue(0.25);

      await auditProvider.runAsync(
        {
          actor: { category: 'system', type: 'System', id: 'test-system' },
        },
        async () => {
          await prisma.$transaction(async (tx) => {
            // User creation (critical, should use awaitWrite: true)
            const user = await tx.user.create({
              data: {
                email: 'txn-user@example.com',
                name: 'Transaction User',
              },
            });

            // Post creation (moderate-volume, should use awaitWrite: false)
            await tx.post.create({
              data: {
                title: 'Transaction Post',
                content: 'Content',
                published: false,
                authorId: user.id,
              },
            });
          });
        },
      );

      // The critical User write is awaited inside the transaction
      const userAuditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });
      expect(userAuditLogs).toHaveLength(1);

      // The Post write is deferred until the transaction commits
      await flushAllPendingWrites();
      const postAuditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'Post' },
        orderBy: { aggregateType: 'asc' },
      });
      expect(postAuditLogs.map((log) => log.aggregateType)).toEqual(['Post', 'User']);

      expect(awaitWriteIfSpy).toHaveBeenCalledWith('User', ['critical', 'pii']);
      expect(awaitWriteIfSpy).toHaveBeenCalledWith('Post', ['user-content', 'moderate-volume']);
      expect(samplingIfSpy).toHaveBeenCalledWith('User', ['critical', 'pii']);
      expect(samplingIfSpy).toHaveBeenCalledWith('Post', ['user-content', 'moderate-volume']);
    });
  });
});
