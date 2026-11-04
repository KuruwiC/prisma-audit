/**
 * Per-model write strategies E2E tests: `write.mode` as a function of the audited model name
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
  type WriteMode,
} from '@kuruwic/prisma-audit';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Models whose audit is written awaited */
const criticalModels = new Set(['User']);

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

  describe('write.mode as a function with database operations', () => {
    it('should write audit log awaited for a model the mode function maps to awaited', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
        }),
      });

      const modeSpy = vi.fn(
        (modelName: string) => (criticalModels.has(modelName) ? 'awaited' : 'deferred') as WriteMode,
      );

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        write: {
          mode: modeSpy,
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
      expect(modeSpy).toHaveBeenCalledWith('User');
    });

    it('should write audit log deferred for a model the mode function maps to deferred', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const modeSpy = vi.fn(
        (modelName: string) => (criticalModels.has(modelName) ? 'awaited' : 'deferred') as WriteMode,
      );

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        write: {
          mode: modeSpy,
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
      expect(modeSpy).toHaveBeenCalledWith('Post');
    });
  });

  describe('Combined per-model strategies in transactions', () => {
    it('should apply different strategies to different models in same transaction', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const modeSpy = vi.fn(
        (modelName: string) => (criticalModels.has(modelName) ? 'awaited' : 'deferred') as WriteMode,
      );

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        write: {
          mode: modeSpy,
        },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'system', type: 'System', id: 'test-system' },
        },
        async () => {
          await prisma.$transaction(async (tx) => {
            // User creation (awaited)
            const user = await tx.user.create({
              data: {
                email: 'txn-user@example.com',
                name: 'Transaction User',
              },
            });

            // Post creation (deferred)
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

      expect(modeSpy).toHaveBeenCalledWith('User');
      expect(modeSpy).toHaveBeenCalledWith('Post');
    });
  });
});
