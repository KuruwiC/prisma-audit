/**
 * Per-model write strategies E2E tests: the `writeMode` of each audited model's entity
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

  describe("an entity's writeMode with database operations", () => {
    it('should write audit log awaited for a model whose entity is awaited', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          writeMode: 'awaited',
          diffExcludeFields: ['updatedAt'],
        }),
      });

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
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
    });

    it('should write audit log deferred for a model whose entity is deferred', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        Post: defineEntity({
          type: 'Post',
          writeMode: 'deferred',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
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
    });
  });

  describe('Combined per-model strategies in transactions', () => {
    it('should write the audit rows of models with different write modes inside the same transaction', async () => {
      const entities = defineEntities<AuditModelName, PrismaClient>()({
        User: defineEntity({
          type: 'User',
          writeMode: 'awaited',
          diffExcludeFields: ['updatedAt'],
        }),
        Post: defineEntity({
          type: 'Post',
          writeMode: 'deferred',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      });

      const prisma = createAuditClient(basePrisma, {
        contextProvider: auditProvider,
        entities,
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'system', type: 'System', id: 'test-system' },
        },
        async () => {
          await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                email: 'txn-user@example.com',
                name: 'Transaction User',
              },
            });

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

      expect(getPendingWriteCount()).toBe(0);

      const userAuditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });
      expect(userAuditLogs).toHaveLength(1);

      const postAuditLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'Post' },
        orderBy: { aggregateType: 'asc' },
      });
      expect(postAuditLogs.map((log) => log.aggregateType)).toEqual(['Post', 'User']);
    });
  });
});
