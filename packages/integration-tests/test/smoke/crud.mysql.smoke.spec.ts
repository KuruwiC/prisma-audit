/**
 * MySQL Smoke Tests - Basic CRUD Operations
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/mysql-client/index.js';
import type { MySQLTestContext } from '../helpers/setup-mysql.js';
import { cleanMySQLDatabase, setupMySQLDatabase, teardownMySQLDatabase } from '../helpers/setup-mysql.js';

describe('CRUD Smoke Tests (MySQL)', () => {
  let context: MySQLTestContext;

  const testActor: AuditContext = {
    actor: {
      category: 'User',
      type: 'User',
      id: 'test-actor-id',
    },
  };

  beforeAll(async () => {
    context = await setupMySQLDatabase();
  });

  afterAll(async () => {
    await teardownMySQLDatabase(context);
  });

  afterEach(async () => {
    await cleanMySQLDatabase(context.prisma);
  });

  describe('CREATE operations', () => {
    it('should create audit log for User creation', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'Test User',
          },
        });
      });

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

      expect(auditLogs[0]?.after).toMatchObject({
        email: 'test@example.com',
        name: 'Test User',
      });
    });

    it('should create audit log for Post creation', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'author@example.com', name: 'Author' },
        });
      });

      // Clear audit logs from user creation
      await context.prisma.auditLog.deleteMany();

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            authorId: user.id,
          },
        });
      });

      // A post create is logged once per aggregate it belongs to: Post and User
      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: post.id,
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(auditLogs).toHaveLength(2);

      expect(auditLogs[0]).toMatchObject({
        action: 'create',
        entityType: 'Post',
        aggregateType: 'Post',
      });

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
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'original@example.com', name: 'Original Name' },
        });
      });

      // Clear creation audit logs
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

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
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'todelete@example.com', name: 'To Delete' },
        });
      });

      const userId = user.id;

      // Clear creation audit logs
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: userId },
        });
      });

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

  describe('nested delete', () => {
    it('records a nested deleted row under the parent as stored when the where names it in another case', async () => {
      await context.prisma.user.create({ data: { id: 'case-user', email: 'case@example.com', name: 'Case' } });
      await context.prisma.post.create({ data: { id: 'p1', title: 'Post', authorId: 'case-user' } });
      await context.prisma.auditLog.deleteMany();

      // MySQL's default collation compares strings case-insensitively, so 'CASE-USER' finds the row stored
      // as 'case-user'
      await context.provider.runAsync(testActor, () =>
        context.prisma.user.update({ where: { id: 'CASE-USER' }, data: { posts: { delete: { id: 'p1' } } } }),
      );

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: 'p1' },
        orderBy: [{ aggregateType: 'asc' }, { aggregateId: 'asc' }],
      });
      expect(
        auditLogs.map((log: Prisma.AuditLogGetPayload<object>) => [log.action, log.aggregateType, log.aggregateId]),
      ).toEqual([
        ['delete', 'Post', 'p1'],
        ['delete', 'User', 'case-user'],
      ]);
    });
  });

  describe('BATCH operations', () => {
    it('should create audit logs for createMany with auto-generated IDs', async () => {
      const result = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1' },
            { email: 'user2@example.com', name: 'User 2' },
            { email: 'user3@example.com', name: 'User 3' },
          ],
        });
      });

      expect(result.count).toBe(3);

      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'create',
          entityType: 'User',
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(auditLogs).toHaveLength(3);

      // Log order is not guaranteed, so match the emails as a set
      const emails = auditLogs.map((log: { after: unknown }) => (log.after as { email?: string })?.email);
      expect(emails).toContain('user1@example.com');
      expect(emails).toContain('user2@example.com');
      expect(emails).toContain('user3@example.com');
    });

    it('should create audit logs for updateMany', async () => {
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

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.updateMany({
          where: { authorId: user.id },
          data: { published: true },
        });
      });

      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'update',
          entityType: 'Post',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);

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

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.deleteMany({
          where: {
            email: {
              startsWith: 'delete',
            },
          },
        });
      });

      const auditLogs = await context.prisma.auditLog.findMany({
        where: {
          action: 'delete',
          entityType: 'User',
        },
      });

      expect(auditLogs).toHaveLength(3);

      for (const log of auditLogs) {
        expect(log.before).not.toBeNull();
        expect(log.after).toBeNull();
      }
    });
  });

  describe('TRANSACTION operations', () => {
    it('should create audit logs within transaction', async () => {
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

      await expect(transactionPromise).rejects.toThrow();

      const auditLogs = await context.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });
  });
});
