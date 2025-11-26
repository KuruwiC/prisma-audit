/**
 * Write Strategy Tests
 */

import type { AggregateMapping } from '@kuruwic/prisma-audit';
import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineEntity,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from './test-helpers.js';

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
  let basePrisma: PrismaClient | null = null;

  beforeAll(async () => {});

  beforeEach(async () => {
    if (basePrisma) {
      await basePrisma.$disconnect();
    }

    const databaseUrl = globalThis.__TEST_DATABASE_URL__ || process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set by global-setup.ts');
    }
    basePrisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
      transactionOptions: {
        maxWait: 30000,
        timeout: 30000,
      },
    });
    await basePrisma.auditLog.deleteMany();
    await basePrisma.post.deleteMany();
    await basePrisma.user.deleteMany();
  });

  afterEach(async () => {
    if (basePrisma) {
      await basePrisma.$disconnect();
      basePrisma = null;
    }
  });

  describe('Sync Mode (awaitWrite: true)', () => {
    it('should write operation and audit log atomically within implicit transaction', async () => {
      if (!basePrisma) {
        throw new Error('basePrisma is not initialized');
      }

      const db = basePrisma;
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        basePrisma: db,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        Prisma,
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

          expect(user).toBeDefined();

          const users = await db.user.findMany();
          expect(users.length).toBe(1);
          const auditLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'create',
            },
          });
          expect(auditLogs.length).toBeGreaterThan(0);
        },
      );

      await prisma.$disconnect();
      await db.$disconnect();
    });

    it('should write audit logs synchronously within explicit transactions', async () => {
      if (!basePrisma) {
        throw new Error('basePrisma is not initialized');
      }

      const db = basePrisma;
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        basePrisma: db,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        Prisma,
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
          const auditLogs = await db.auditLog.findMany();
          expect(auditLogs.length).toBeGreaterThan(0);
        },
      );

      await prisma.$disconnect();
      await db.$disconnect();
    });
  });

  describe('Async Mode (awaitWrite: false)', () => {
    it('should write audit logs asynchronously without blocking the main operation (fire and forget)', async () => {
      if (!basePrisma) {
        throw new Error('basePrisma is not initialized');
      }

      const db = basePrisma;
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        basePrisma: db,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
        Prisma,
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

          expect(user).toBeDefined();

          const users = await db.user.findMany();
          expect(users.length).toBe(1);
          expect(users[0].email).toBe('test@example.com');
          await waitFor(
            async () =>
              db.auditLog.findMany({
                where: {
                  entityType: 'User',
                  entityId: user.id,
                  action: 'create',
                },
              }),
            { timeout: 5000, interval: 50, checkFn: (logs) => logs.length > 0 },
          );
          const auditLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
            },
          });
          expect(auditLogs.length).toBeGreaterThan(0);
        },
      );

      await prisma.$disconnect();
      await db.$disconnect();
    });

    it('should write audit logs asynchronously within explicit transactions', async () => {
      if (!basePrisma) {
        throw new Error('basePrisma is not initialized');
      }

      const db = basePrisma;
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        basePrisma: db,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
        Prisma,
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
          const auditLogs = await waitFor(async () => db.auditLog.findMany(), {
            timeout: 5000,
            interval: 50,
            checkFn: (logs) => logs.length >= 3,
          });
          expect(auditLogs.length).toBeGreaterThan(0);
        },
      );

      await prisma.$disconnect();
      await db.$disconnect();
    });
  });

  describe('Transaction Coverage', () => {
    it('should create audit logs for multiple sequential operations with implicit transactions (sync)', async () => {
      if (!basePrisma) {
        throw new Error('basePrisma is not initialized');
      }

      const db = basePrisma;
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        basePrisma: db,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        Prisma,
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

          expect(user).toBeDefined();

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

          expect(createLogs.length).toBeGreaterThan(0);
          expect(updateLogs.length).toBeGreaterThan(0);
        },
      );

      await prisma.$disconnect();
      await db.$disconnect();
    });

    it('should create audit logs for all operations within explicit multi-statement transaction (sync)', async () => {
      if (!basePrisma) {
        throw new Error('basePrisma is not initialized');
      }

      const db = basePrisma;
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        provider: auditProvider,
        basePrisma: db,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        Prisma,
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

          expect(result.user).toBeDefined();
          expect(result.post).toBeDefined();

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

          expect(userLogs.length).toBeGreaterThan(0);
          expect(postLogs.length).toBeGreaterThan(0);
        },
      );

      await prisma.$disconnect();
      await db.$disconnect();
    });
  });

  afterAll(async () => {
    if (basePrisma) {
      try {
        await basePrisma.$disconnect();
      } catch {}
      basePrisma = null;
    }
  });
});
