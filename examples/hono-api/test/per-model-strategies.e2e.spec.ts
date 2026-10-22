/**
 * Per-model write strategies E2E tests: `write.awaited` and `samplingRate` as functions of the
 * operation's model name
 */

import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineEntities,
  defineEntity,
  flushAllPendingWrites,
  foreignKey,
  getPendingWriteCount,
  to,
} from '@kuruwic/prisma-audit';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Models whose audit is awaited and always sampled in */
const criticalModels = new Set(['User']);
/** Models sampled in at a reduced rate */
const moderateVolumeModels = new Set(['Post']);

describe('Per-model Strategies E2E', () => {
  let basePrisma: PrismaClient;
  const auditProvider = createAsyncLocalStorageProvider();

  beforeEach(async () => {
    basePrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await basePrisma.$disconnect();
  });

  describe('write.awaited as a function with database operations', () => {
    it('should write audit log synchronously for a model the function awaits', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
        }),
      });

      const awaitedSpy = vi.fn((modelName: string) => criticalModels.has(modelName));

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        write: {
          awaited: awaitedSpy,
        },
        Prisma,
        schema: auditSchema,
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
          expect(getPendingWriteCount()).toBe(0);
        },
      );

      const auditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]?.action).toBe('create');
      expect(auditLogs[0]?.entityCategory).toBe('model');
      expect(awaitedSpy).toHaveBeenCalledWith('User');
    });

    it('should write audit log asynchronously for a model the function does not await', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const awaitedSpy = vi.fn((modelName: string) => criticalModels.has(modelName));

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        write: {
          awaited: awaitedSpy,
        },
        Prisma,
        schema: auditSchema,
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
          expect(getPendingWriteCount()).toBe(1);
        },
      );

      await flushAllPendingWrites();
      const auditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'Post' },
      });

      expect(auditLogs.map((log) => log.aggregateType).sort()).toEqual(['Post', 'User']);
      expect(awaitedSpy).toHaveBeenCalledWith('Post');
    });
  });

  describe('samplingRate as a function with database operations', () => {
    it('should apply 100% sampling to a model the function returns 1 for', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
        }),
      });

      const samplingRateSpy = vi.fn((modelName: string) => (criticalModels.has(modelName) ? 1.0 : 0.0));

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        samplingRate: samplingRateSpy,
        write: {
          awaited: true, // Ensure synchronous for testing
        },
        Prisma,
        schema: auditSchema,
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
      expect(samplingRateSpy).toHaveBeenCalledWith('User');
    });

    it('should apply a reduced sampling rate to a model the function returns one for', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });
      let callCount = 0;
      const samplingRateSpy = vi.fn((modelName: string) => {
        if (!moderateVolumeModels.has(modelName)) {
          return 1.0;
        }
        callCount++;
        return callCount % 3 === 0 ? 1.0 : 0.0;
      });

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        samplingRate: samplingRateSpy,
        write: {
          awaited: true,
        },
        Prisma,
        schema: auditSchema,
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
      expect(samplingRateSpy).toHaveBeenCalledTimes(operationCount);
      expect(samplingRateSpy).toHaveBeenCalledWith('Post');
    });
  });

  describe('Combined per-model strategies in transactions', () => {
    it('should apply different strategies to different models in same transaction', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const awaitedSpy = vi.fn((modelName: string) => criticalModels.has(modelName));

      const samplingRateSpy = vi.fn((modelName: string) => {
        if (criticalModels.has(modelName)) return 1.0;
        if (moderateVolumeModels.has(modelName)) return 0.5;
        return 1.0;
      });

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        samplingRate: samplingRateSpy,
        write: {
          awaited: awaitedSpy,
        },
        Prisma,
        schema: auditSchema,
      });

      // Below the 0.5 rate of the moderate-volume Post: its write is sampled in
      vi.spyOn(Math, 'random').mockReturnValue(0.25);

      await auditProvider.runAsync(
        {
          actor: { category: 'system', type: 'System', id: 'test-system' },
        },
        async () => {
          await prisma.$transaction(async (tx) => {
            // User creation (critical, awaited)
            const user = await tx.user.create({
              data: {
                email: 'txn-user@example.com',
                name: 'Transaction User',
              },
            });

            // Post creation (moderate-volume, not awaited)
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

      expect(awaitedSpy).toHaveBeenCalledWith('User');
      expect(awaitedSpy).toHaveBeenCalledWith('Post');
      expect(samplingRateSpy).toHaveBeenCalledWith('User');
      expect(samplingRateSpy).toHaveBeenCalledWith('Post');
    });
  });
});
