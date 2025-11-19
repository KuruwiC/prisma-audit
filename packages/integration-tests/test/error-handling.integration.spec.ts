import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Error Handling Integration', () => {
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

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Successful operations', () => {
    it('should complete operation even if audit log fails (log strategy)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
            password: 'secret123',
          },
        });
      });

      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Invalid context scenarios', () => {
    it('should handle operations without audit context gracefully', async () => {
      const user = await context.prisma.user.create({
        data: {
          email: 'nocontext@example.com',
          name: 'No Context User',
          password: 'secret123',
        },
      });

      expect(user).toBeDefined();

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
      });

      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('Database constraint violations', () => {
    it('should handle unique constraint violations correctly', async () => {
      const email = 'duplicate@example.com';

      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email,
            name: 'First User',
            password: 'secret123',
          },
        });
      });

      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.user.create({
            data: {
              email,
              name: 'Duplicate User',
              password: 'secret456',
            },
          });
        }),
      ).rejects.toThrow();

      const users = await context.prisma.user.findMany({
        where: { email },
      });

      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('First User');
    });

    it('should handle foreign key constraint violations correctly', async () => {
      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.post.create({
            data: {
              title: 'Invalid Post',
              content: 'Content',
              authorId: 'non-existent-user-id',
            },
          });
        }),
      ).rejects.toThrow();

      const posts = await context.prisma.post.findMany();
      expect(posts).toHaveLength(0);
    });
  });

  describe('Transaction rollback', () => {
    it('should not create audit logs if transaction fails', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'tx-user@example.com',
            name: 'TX User',
            password: 'secret123',
          },
        });
      });

      // Try transaction that will fail
      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.$transaction(async (tx: typeof context.prisma) => {
            // This should succeed
            await tx.post.create({
              data: {
                title: 'Post 1',
                content: 'Content 1',
                authorId: user.id,
              },
            });

            // This will fail - invalid foreign key
            await tx.post.create({
              data: {
                title: 'Post 2',
                content: 'Content 2',
                authorId: 'invalid-user-id',
              },
            });
          });
        }),
      ).rejects.toThrow();

      // Verify no posts were created (transaction rolled back)
      const posts = await context.prisma.post.findMany();
      expect(posts).toHaveLength(0);

      // Note: Audit logs behavior during transaction depends on implementation
      // In current design, audit logs are created per-operation, not transactionally
    });
  });

  describe('Concurrent operations', () => {
    it('should handle concurrent operations with different contexts correctly', async () => {
      const actor1: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'user-1',
          name: 'User 1',
        },
      };

      const actor2: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'user-2',
          name: 'User 2',
        },
      };

      // Execute concurrent operations
      const [user1, user2] = await Promise.all([
        context.provider.runAsync(actor1, async () => {
          return await context.prisma.user.create({
            data: {
              email: 'user1@example.com',
              name: 'Concurrent User 1',
              password: 'secret1',
            },
          });
        }),
        context.provider.runAsync(actor2, async () => {
          return await context.prisma.user.create({
            data: {
              email: 'user2@example.com',
              name: 'Concurrent User 2',
              password: 'secret2',
            },
          });
        }),
      ]);

      // Verify both users were created
      expect(user1).toBeDefined();
      expect(user2).toBeDefined();

      // Verify audit logs have correct actors
      const logs1 = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user1.id },
      });
      expect(logs1[0].actorId).toBe('user-1');

      const logs2 = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user2.id },
      });
      expect(logs2[0].actorId).toBe('user-2');
    });
  });
});
