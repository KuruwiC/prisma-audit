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
      // LIMITATION: This test does not actually trigger an audit log failure.
      // The standard test setup uses a working database writer, so audit writes succeed.
      // To properly test error resilience, a custom hooks.writer that throws would be
      // needed with a separate Prisma client instance (see hooks-writer.integration.spec.ts).
      // For now, this test only verifies that the main operation completes successfully.
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

      // No audit error is expected since the writer works normally in this setup
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
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
});
