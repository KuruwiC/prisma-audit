import type { AuditContext } from '@kuruwic/db-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createTestContext, disposeTestContext, type TestContext } from './helpers/setup.js';

describe('Nested Update Operations', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
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

  describe('with fetchBeforeOperation: true (test setup)', () => {
    it('should create audit log with before state for nested update', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Original Title',
            content: 'Original content',
            authorId: user.id,
          },
        });
      });

      // Clear audit logs from setup
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Updated Author',
            posts: {
              update: {
                where: { id: post.id },
                data: { title: 'Updated Title' },
              },
            },
          },
          include: { posts: true },
        });
      });

      // Note: Top-level update operations also use the fetchBeforeOperation config
      const userLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });
      expect(userLogs).toHaveLength(1);
      expect(userLogs[0].before).not.toBeNull(); // fetchBeforeOperation=true (test setup)
      expect(userLogs[0].after).not.toBeNull();

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, action: 'update' },
      });
      expect(postLogs).toHaveLength(2); // One entity log, one aggregate log
      for (const log of postLogs) {
        expect(log.before).not.toBeNull(); // fetchBeforeOperation=true (test setup)
        expect(log.after).not.toBeNull();
        expect(log.changes).not.toBeNull(); // changes is available with before state
        const after = log.after as { title?: string };
        expect(after.title).toBe('Updated Title');
      }
    });
  });

  // NOTE: The tests in this file use the setup.ts configuration (fetchBeforeOperation: true).
  // The fetchBeforeOperation: false path is covered by nested-batch-parent-scope.integration.spec.ts
  // and performance.integration.spec.ts, each with its own client.

  describe('Transaction Atomicity', () => {
    it('should NOT create audit log if main operation fails in transaction', async () => {
      const user1 = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user1@example.com',
            name: 'User 1',
            password: 'secret123',
          },
        });
      });

      // A second user whose email the update below collides with
      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user2@example.com',
            name: 'User 2',
            password: 'secret123',
          },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Content',
            authorId: user1.id,
          },
        });
      });

      const initialLogCount = await context.prisma.auditLog.count();

      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.update({
            where: { id: user1.id },
            data: {
              posts: {
                update: {
                  where: { id: post.id },
                  data: { title: 'New Title' }, // This would succeed
                },
              },
              // This will cause the main operation to fail (unique constraint)
              email: 'user2@example.com',
            },
          });
        });
      });

      await expect(transactionPromise).rejects.toThrow();

      const finalLogCount = await context.prisma.auditLog.count();
      expect(finalLogCount).toBe(initialLogCount);

      const finalPost = await context.prisma.post.findUnique({ where: { id: post.id } });
      expect(finalPost?.title).toBe('Test Post');
    });

    it('should roll back nested update if transaction fails', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Original Title',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.update({
            where: { id: user.id },
            data: {
              posts: {
                update: {
                  where: { id: post.id },
                  data: { title: 'Updated Title' },
                },
              },
            },
          });
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      const finalPost = await context.prisma.post.findUnique({ where: { id: post.id } });
      expect(finalPost?.title).toBe('Original Title');
    });
  });

  describe('Empty Results', () => {
    it('should handle nested update with no matching records', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Clear audit logs from setup
      await context.prisma.auditLog.deleteMany();

      // Prisma throws an error when trying to update non-existent nested records
      const updatePromise = context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Updated User',
            posts: {
              update: {
                where: { id: 'non-existent-post-id' },
                data: { title: 'Should not be created' },
              },
            },
          },
          include: { posts: true },
        });
      });

      await expect(updatePromise).rejects.toThrow();

      // Verify: No audit logs should be created due to transaction rollback
      const auditLogs = await context.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('updateMany nested operation', () => {
    it('should handle updateMany for multiple records', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
            posts: {
              create: [
                { title: 'Post 1', content: 'Content 1', published: false },
                { title: 'Post 2', content: 'Content 2', published: false },
                { title: 'Post 3', content: 'Content 3', published: false },
              ],
            },
          },
          include: { posts: true },
        });
      });

      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              updateMany: {
                where: { published: false },
                data: { published: true },
              },
            },
          },
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'update' },
        orderBy: [{ entityId: 'asc' }, { aggregateType: 'asc' }],
      });

      // The rows the nested `updateMany` filter matches under this user are read ahead of the
      // write, scoped to the parent the way Prisma scopes the write, so each of the 3 posts is
      // audited once per aggregate root (Post itself and its User) with its before state.
      const postIds: string[] = user.posts.map((post: { id: string }) => post.id).sort();
      expect(
        postLogs.map((log: { entityId: string; aggregateType: string }) => [log.entityId, log.aggregateType]),
      ).toEqual(
        postIds.flatMap((id) => [
          [id, 'Post'],
          [id, 'User'],
        ]),
      );
      for (const log of postLogs) {
        expect((log.before as { published?: boolean }).published).toBe(false);
        expect((log.after as { published?: boolean }).published).toBe(true);
      }
    });
  });

  describe('Where Clause Accuracy', () => {
    it('should pre-fetch only the correct record when multiple posts exist', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      const [post1, post2, post3] = await context.provider.runAsync(testActor, async () => {
        return Promise.all([
          context.prisma.post.create({
            data: {
              title: 'Post 1',
              content: 'Content 1',
              authorId: user.id,
              published: false,
            },
          }),
          context.prisma.post.create({
            data: {
              title: 'Post 2',
              content: 'Content 2',
              authorId: user.id,
              published: false,
            },
          }),
          context.prisma.post.create({
            data: {
              title: 'Post 3',
              content: 'Content 3',
              authorId: user.id,
              published: false,
            },
          }),
        ]);
      });

      // Clear audit logs from setup
      await context.prisma.auditLog.deleteMany();

      // The user itself is not updated, only the nested post, so only post2 gets audit logs
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: {
                where: { id: post2.id },
                data: { title: 'Updated Post 2' },
              },
            },
          },
          include: { posts: true },
        });
      });

      // `include: { posts: true }` returns every post of the user, but only the post the update
      // names is the update's row: its siblings match no nested operation and get no entry.
      const postLogs: { entityId: string; aggregateType: string; before: unknown; after: unknown }[] =
        await context.prisma.auditLog.findMany({
          where: { entityType: 'Post', action: 'update' },
          orderBy: { aggregateType: 'asc' },
        });

      expect(postLogs.map((log) => [log.entityId, log.aggregateType])).toEqual([
        [post2.id, 'Post'],
        [post2.id, 'User'],
      ]);
      expect(postLogs.map((log) => log.entityId)).not.toContain(post1.id);
      expect(postLogs.map((log) => log.entityId)).not.toContain(post3.id);

      // With fetchBeforeOperation: true (test setup), the updated post carries its before state.
      for (const log of postLogs) {
        expect((log.before as { title: string }).title).toBe('Post 2');
        expect((log.after as { title: string }).title).toBe('Updated Post 2');
      }
    });

    it('should handle updateMany with where clause correctly', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      const [unpublished1, unpublished2, published1] = await context.provider.runAsync(testActor, async () => {
        return Promise.all([
          context.prisma.post.create({
            data: {
              title: 'Unpublished 1',
              content: 'Content',
              authorId: user.id,
              published: false,
            },
          }),
          context.prisma.post.create({
            data: {
              title: 'Unpublished 2',
              content: 'Content',
              authorId: user.id,
              published: false,
            },
          }),
          context.prisma.post.create({
            data: {
              title: 'Published 1',
              content: 'Content',
              authorId: user.id,
              published: true,
            },
          }),
        ]);
      });

      // Clear audit logs from setup
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              updateMany: {
                where: { published: false },
                data: { published: true },
              },
            },
          },
        });
      });

      const unpublished1Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: unpublished1.id, action: 'update' },
      });
      const unpublished2Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: unpublished2.id, action: 'update' },
      });
      const published1Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: published1.id, action: 'update' },
      });

      // published1 was never targeted, so it must have no update logs regardless.
      expect(published1Logs).toHaveLength(0);
      // unpublished1 and unpublished2 are the rows the nested `updateMany` filter matches under
      // this user: each is audited once per aggregate root (Post itself and its User), with the
      // before state read ahead of the write.
      for (const logs of [unpublished1Logs, unpublished2Logs]) {
        expect(logs.map((log: { aggregateType: string }) => log.aggregateType).sort()).toEqual(['Post', 'User']);
        for (const log of logs) {
          expect((log.before as { published?: boolean }).published).toBe(false);
          expect((log.after as { published?: boolean }).published).toBe(true);
        }
      }

      const finalPublished1 = await context.prisma.post.findUnique({
        where: { id: published1.id },
      });
      expect(finalPublished1?.published).toBe(true); // Still published (was already true)

      const finalUnpublished1 = await context.prisma.post.findUnique({
        where: { id: unpublished1.id },
      });
      expect(finalUnpublished1?.published).toBe(true);

      const finalUnpublished2 = await context.prisma.post.findUnique({
        where: { id: unpublished2.id },
      });
      expect(finalUnpublished2?.published).toBe(true);
    });
  });

  // NOTE: Every test here uses the setup.ts defaults; the per-model vs global resolution of
  // nestedOperations is covered by nested-delete.integration.spec.ts.

  // NOTE: Audit-pipeline failures reach errorHandling.observer; nested pre-fetch failures are covered
  // by nested-pre-fetch-failure.integration.spec.ts.
});
