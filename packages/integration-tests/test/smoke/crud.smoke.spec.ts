/**
 * SQLite/MySQL Smoke Tests - Basic CRUD Operations
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/sqlite-client/index.js';
import type { SQLiteTestContext } from '../helpers/setup-sqlite.js';
import { cleanSQLiteDatabase, setupSQLiteDatabase, teardownSQLiteDatabase } from '../helpers/setup-sqlite.js';

describe('CRUD Smoke Tests (SQLite)', () => {
  let context: SQLiteTestContext;

  const testActor: AuditContext = {
    actor: {
      category: 'User',
      type: 'User',
      id: 'test-actor-id',
    },
  };

  beforeAll(async () => {
    context = await setupSQLiteDatabase();
  });

  afterAll(async () => {
    await teardownSQLiteDatabase(context);
  });

  afterEach(async () => {
    await cleanSQLiteDatabase(context.prisma);
  });

  describe('CREATE operations', () => {
    it('should create audit log for User creation', async () => {
      // Act: Create user within audit context
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'Test User',
          },
        });
      });

      // Assert: Verify audit log was created
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: user.id,
        },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: 'create',
        entityType: 'User',
        entityId: user.id,
        aggregateType: 'User',
        aggregateId: user.id,
        actorType: 'User',
        actorId: 'test-actor-id',
      });

      // Verify 'after' contains created data
      expect(auditLogs[0]?.after).toMatchObject({
        email: 'test@example.com',
        name: 'Test User',
      });
    });

    it('should create audit log for Post creation', async () => {
      // Arrange: Create user first
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'author@example.com', name: 'Author' },
        });
      });

      // Clear audit logs from user creation
      await context.prisma.auditLog.deleteMany();

      // Act: Create post
      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            authorId: user.id,
          },
        });
      });

      // Assert: Verify audit logs for both Post and User aggregates
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: post.id,
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(auditLogs).toHaveLength(2);

      // Post aggregate
      expect(auditLogs[0]).toMatchObject({
        action: 'create',
        entityType: 'Post',
        aggregateType: 'Post',
      });

      // User aggregate
      expect(auditLogs[1]).toMatchObject({
        action: 'create',
        entityType: 'Post',
        aggregateType: 'User',
        aggregateId: user.id,
      });
    });
  });

  describe('UPDATE operations', () => {
    it('should create audit log with before/after for update', async () => {
      // Arrange: Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'original@example.com', name: 'Original Name' },
        });
      });

      // Clear creation audit logs
      await context.prisma.auditLog.deleteMany();

      // Act: Update user
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      // Assert: Verify update audit log
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'update',
          entityType: 'User',
          entityId: user.id,
        },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]?.before).toMatchObject({
        name: 'Original Name',
      });
      expect(auditLogs[0]?.after).toMatchObject({
        name: 'Updated Name',
      });
      expect(auditLogs[0]?.changes).toMatchObject({
        name: {
          old: 'Original Name',
          new: 'Updated Name',
        },
      });
    });
  });

  describe('DELETE operations', () => {
    it('should create audit log with before state for delete', async () => {
      // Arrange: Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'todelete@example.com', name: 'To Delete' },
        });
      });

      const userId = user.id;

      // Clear creation audit logs
      await context.prisma.auditLog.deleteMany();

      // Act: Delete user
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: userId },
        });
      });

      // Assert: Verify delete audit log
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'delete',
          entityType: 'User',
          entityId: userId,
        },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]?.before).toMatchObject({
        email: 'todelete@example.com',
        name: 'To Delete',
      });
      expect(auditLogs[0]?.after).toBeNull();
    });
  });

  describe('BATCH operations', () => {
    it('should create audit logs for createMany with auto-generated IDs', async () => {
      // Act: Create multiple users using createMany
      const result = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1' },
            { email: 'user2@example.com', name: 'User 2' },
            { email: 'user3@example.com', name: 'User 3' },
          ],
        });
      });

      // Assert: Verify batch result
      expect(result.count).toBe(3);

      // Verify audit logs were created for all users
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'create',
          entityType: 'User',
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(auditLogs).toHaveLength(3);

      // Verify all expected emails are present (order may vary)
      const emails = auditLogs.map((log: { after: unknown }) => (log.after as { email?: string })?.email);
      expect(emails).toContain('user1@example.com');
      expect(emails).toContain('user2@example.com');
      expect(emails).toContain('user3@example.com');
    });

    it('should create audit logs for updateMany', async () => {
      // Arrange: Create multiple posts
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'author@example.com', name: 'Author' },
        });
      });

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.createMany({
          data: [
            { title: 'Post 1', authorId: user.id, published: false },
            { title: 'Post 2', authorId: user.id, published: false },
            { title: 'Post 3', authorId: user.id, published: false },
          ],
        });
      });

      // Clear creation audit logs
      await context.prisma.auditLog.deleteMany();

      // Act: Update all posts
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.updateMany({
          where: { authorId: user.id },
          data: { published: true },
        });
      });

      // Assert: Verify update audit logs
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'update',
          entityType: 'Post',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);

      // Verify all have published changed
      for (const log of auditLogs) {
        expect(log.changes).toMatchObject({
          published: {
            old: false,
            new: true,
          },
        });
      }
    });

    it('should create audit logs for deleteMany', async () => {
      // Arrange: Create multiple users
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.createMany({
          data: [
            { email: 'delete1@example.com', name: 'Delete 1' },
            { email: 'delete2@example.com', name: 'Delete 2' },
            { email: 'delete3@example.com', name: 'Delete 3' },
          ],
        });
      });

      // Clear creation audit logs
      await context.prisma.auditLog.deleteMany();

      // Act: Delete all users with email starting with 'delete'
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.deleteMany({
          where: {
            email: {
              startsWith: 'delete',
            },
          },
        });
      });

      // Assert: Verify delete audit logs
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'delete',
          entityType: 'User',
        },
      });

      expect(auditLogs).toHaveLength(3);

      // Verify all have 'before' state and null 'after'
      for (const log of auditLogs) {
        expect(log.before).not.toBeNull();
        expect(log.after).toBeNull();
      }
    });
  });

  describe('TRANSACTION operations', () => {
    it('should create audit logs within transaction', async () => {
      // Act: Create multiple entities in a transaction
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: { email: 'txuser@example.com', name: 'TX User' },
          });

          await tx.post.create({
            data: {
              title: 'TX Post',
              authorId: user.id,
            },
          });
        });
      });

      // Assert: Verify audit logs were created
      const userLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post' },
      });

      expect(userLogs).toHaveLength(1);
      expect(postLogs).toHaveLength(2); // Post + User aggregate
    });

    it('should NOT create audit logs if transaction rolls back', async () => {
      // Act: Attempt transaction that will fail
      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.user.create({
            data: { email: 'willrollback@example.com', name: 'Will Rollback' },
          });

          // Force error with duplicate email
          await tx.user.create({
            data: { email: 'willrollback@example.com', name: 'Duplicate' },
          });
        });
      });

      // Assert: Transaction should fail
      await expect(transactionPromise).rejects.toThrow();

      // Verify no audit logs were created
      const auditLogs = await context.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });
  });
});
