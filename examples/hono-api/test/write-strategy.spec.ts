/**
 * Write Strategy Tests
 */

import type { AggregateMapping } from '@kuruwic/prisma-audit';
import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineEntity,
  flushAllPendingWrites,
  foreignKey,
  getPendingWriteCount,
  to,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const testAggregateMapping: AggregateMapping = {
  User: defineEntity({
    type: 'User',
  }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
};

describe('Write Strategy Tests', () => {
  let db: PrismaClient;

  beforeEach(() => {
    db = new PrismaClient({
      transactionOptions: {
        maxWait: 30000,
        timeout: 30000,
      },
    });
  });

  afterEach(async () => {
    await db.$disconnect();
  });

  describe('Async Mode (awaitWrite: false)', () => {
    it('should write audit logs asynchronously without blocking the main operation (fire and forget)', async () => {
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
        },
        async () => {
          const user = await prisma.user.create({
            data: {
              email: 'test@example.com',
              name: 'Test User',
            },
          });

          expect(getPendingWriteCount()).toBe(1);

          const users = await db.user.findMany();
          expect(users.length).toBe(1);
          expect(users[0].email).toBe('test@example.com');

          await flushAllPendingWrites();
          expect(getPendingWriteCount()).toBe(0);

          const auditLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'create',
            },
          });
          expect(auditLogs).toHaveLength(1);
        },
      );
    });

    it('should write audit logs asynchronously within explicit transactions', async () => {
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
        },
        async () => {
          await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                email: 'test@example.com',
                name: 'Test User',
              },
            });

            await tx.post.create({
              data: {
                title: 'Test Post',
                content: 'Test Content',
                published: true,
                authorId: user.id,
              },
            });
          });

          const users = await db.user.findMany();
          const posts = await db.post.findMany();
          expect(users.length).toBe(1);
          expect(posts.length).toBe(1);

          await flushAllPendingWrites();
          expect(getPendingWriteCount()).toBe(0);

          const auditLogs = await db.auditLog.findMany();
          expect(auditLogs.map((log) => `${log.entityType}/${log.aggregateType}`).sort()).toEqual([
            'Post/Post',
            'Post/User',
            'User/User',
          ]);
        },
      );
    });
  });

  describe('Transaction Coverage', () => {
    it('should create audit logs for multiple sequential operations (sync)', async () => {
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
        },
        async () => {
          const user = await prisma.user.create({
            data: {
              email: 'test@example.com',
              name: 'Test User',
            },
          });

          expect(user.email).toBe('test@example.com');

          const updated = await prisma.user.update({
            where: { id: user.id },
            data: { name: 'Updated Name' },
          });

          expect(updated.name).toBe('Updated Name');

          const createLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'create',
            },
          });

          const updateLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'update',
            },
          });

          expect(createLogs).toHaveLength(1);
          expect(updateLogs).toHaveLength(1);
          expect(updateLogs[0]?.changes).toMatchObject({ name: { old: 'Test User', new: 'Updated Name' } });
        },
      );
    });

    it('should create audit logs for all operations within explicit multi-statement transaction (sync)', async () => {
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
        },
        async () => {
          const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                email: 'test@example.com',
                name: 'Test User',
              },
            });

            const post = await tx.post.create({
              data: {
                title: 'Test Post',
                content: 'Test Content',
                published: true,
                authorId: user.id,
              },
            });

            return { user, post };
          });

          expect(result.user.email).toBe('test@example.com');
          expect(result.post.authorId).toBe(result.user.id);

          const userLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: result.user.id,
            },
          });

          const postLogs = await db.auditLog.findMany({
            where: {
              entityType: 'Post',
              entityId: result.post.id,
            },
          });

          expect(userLogs).toHaveLength(1);
          expect(postLogs).toHaveLength(2);
        },
      );
    });
  });
});
