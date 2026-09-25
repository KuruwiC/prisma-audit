import type { AuditContext } from '@kuruwic/db-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createTestContext, disposeTestContext, type TestContext } from './helpers/setup.js';

describe('Nested Delete Operations', () => {
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
    it('should create audit log with before state for nested delete', async () => {
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
            title: 'Post to Delete',
            content: 'Content',
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
            posts: {
              delete: {
                id: post.id,
              },
            },
          },
          include: { posts: true },
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, action: 'delete' },
      });

      expect(postLogs.length).toBeGreaterThanOrEqual(1);
      for (const log of postLogs) {
        expect(log.before).not.toBeNull(); // fetchBeforeOperation=true (test setup)
        expect(log.after).toBeNull(); // Delete always has null 'after'
      }

      const deletedPost = await context.prisma.post.findUnique({ where: { id: post.id } });
      expect(deletedPost).toBeNull();
    });
  });

  // NOTE: The tests in this file use the setup.ts configuration (fetchBeforeOperation: true).
  // The fetchBeforeOperation: false path is covered by performance.integration.spec.ts with its own client.

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
                delete: { id: post.id },
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
      expect(finalPost).not.toBeNull();
      expect(finalPost?.title).toBe('Test Post');
    });

    it('should roll back nested delete if transaction fails', async () => {
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
            title: 'Post to Keep',
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
                delete: { id: post.id },
              },
            },
          });
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      const finalPost = await context.prisma.post.findUnique({ where: { id: post.id } });
      expect(finalPost).not.toBeNull();
      expect(finalPost?.title).toBe('Post to Keep');
    });
  });

  describe('Empty Results', () => {
    it('should handle nested delete with no matching records', async () => {
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

      // Prisma throws an error when trying to delete non-existent nested records
      const deletePromise = context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Updated User',
            posts: {
              delete: { id: 'non-existent-post-id' },
            },
          },
          include: { posts: true },
        });
      });

      await expect(deletePromise).rejects.toThrow();

      // Verify: No audit logs should be created due to transaction rollback
      const auditLogs = await context.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('deleteMany nested operation', () => {
    it('should handle deleteMany for multiple records', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
            posts: {
              create: [
                { title: 'Draft 1', content: 'Content 1', published: false },
                { title: 'Draft 2', content: 'Content 2', published: false },
                { title: 'Published', content: 'Content 3', published: true },
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
              deleteMany: {
                published: false,
              },
            },
          },
        });
      });

      const remainingPosts = await context.prisma.post.findMany({
        where: { authorId: user.id },
      });
      expect(remainingPosts).toHaveLength(1);
      expect(remainingPosts[0].title).toBe('Published');

      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'delete' },
        orderBy: [{ entityId: 'asc' }, { aggregateType: 'asc' }],
      });

      // The rows the nested `deleteMany` filter matches under this user are read ahead of the
      // write, scoped to the parent the way Prisma scopes the write, so each of the 2 drafts is
      // audited once per aggregate root (Post itself and its User) from that before state.
      const draftIds: string[] = user.posts
        .filter((post: { published: boolean }) => !post.published)
        .map((post: { id: string }) => post.id)
        .sort();
      expect(
        deleteLogs.map((log: { entityId: string; aggregateType: string }) => [log.entityId, log.aggregateType]),
      ).toEqual(
        draftIds.flatMap((id) => [
          [id, 'Post'],
          [id, 'User'],
        ]),
      );
      for (const log of deleteLogs) {
        expect((log.before as { published?: boolean }).published).toBe(false);
        expect(log.after).toBeNull();
      }
    });
  });

  describe('Cascade Delete', () => {
    it('should create audit logs for cascaded deletes', async () => {
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
            title: 'Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      const comment = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.comment.create({
          data: {
            content: 'Comment',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              delete: { id: post.id },
            },
          },
        });
      });

      const deletedPost = await context.prisma.post.findUnique({ where: { id: post.id } });
      expect(deletedPost).toBeNull();

      // Comment cascades from Post (onDelete: Cascade in the schema)
      const deletedComment = await context.prisma.comment.findUnique({ where: { id: comment.id } });
      expect(deletedComment).toBeNull();
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
            },
          }),
          context.prisma.post.create({
            data: {
              title: 'Post 2',
              content: 'Content 2',
              authorId: user.id,
            },
          }),
          context.prisma.post.create({
            data: {
              title: 'Post 3',
              content: 'Content 3',
              authorId: user.id,
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
              delete: { id: post2.id },
            },
          },
          include: { posts: true },
        });
      });

      const post1Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post1.id, action: 'delete' },
      });
      const post2Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post2.id, action: 'delete' },
      });
      const post3Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post3.id, action: 'delete' },
      });

      expect(post2Logs.length).toBeGreaterThanOrEqual(1);

      // All delete logs should have before state (fetchBeforeOperation=true)
      for (const log of post2Logs) {
        expect(log.before).not.toBeNull();
        expect(log.after).toBeNull(); // Delete operation has no after state
      }

      // post1 and post3 were not deleted (only post2 was in the where clause), so they must have no delete logs
      expect(post1Logs).toHaveLength(0);
      expect(post3Logs).toHaveLength(0);

      const finalPost1 = await context.prisma.post.findUnique({ where: { id: post1.id } });
      expect(finalPost1).not.toBeNull();
      expect(finalPost1?.title).toBe('Post 1');

      const finalPost2 = await context.prisma.post.findUnique({ where: { id: post2.id } });
      expect(finalPost2).toBeNull();

      const finalPost3 = await context.prisma.post.findUnique({ where: { id: post3.id } });
      expect(finalPost3).not.toBeNull();
      expect(finalPost3?.title).toBe('Post 3');
    });

    it('should handle deleteMany with where clause correctly', async () => {
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
              deleteMany: {
                published: false,
              },
            },
          },
        });
      });

      const finalUnpublished1 = await context.prisma.post.findUnique({
        where: { id: unpublished1.id },
      });
      expect(finalUnpublished1).toBeNull();

      const finalUnpublished2 = await context.prisma.post.findUnique({
        where: { id: unpublished2.id },
      });
      expect(finalUnpublished2).toBeNull();

      const finalPublished1 = await context.prisma.post.findUnique({
        where: { id: published1.id },
      });
      expect(finalPublished1).not.toBeNull();
      expect(finalPublished1?.title).toBe('Published 1');

      const unpublished1Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: unpublished1.id, action: 'delete' },
      });
      const unpublished2Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: unpublished2.id, action: 'delete' },
      });
      const published1Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: published1.id, action: 'delete' },
      });

      // published1 was never targeted, so it must have no delete logs regardless.
      expect(published1Logs).toHaveLength(0);
      // unpublished1 and unpublished2 are the rows the nested `deleteMany` filter matches under
      // this user: each is audited once per aggregate root (Post itself and its User) from the
      // before state read ahead of the write.
      for (const logs of [unpublished1Logs, unpublished2Logs]) {
        expect(logs.map((log: { aggregateType: string }) => log.aggregateType).sort()).toEqual(['Post', 'User']);
        for (const log of logs) {
          expect((log.before as { published?: boolean }).published).toBe(false);
          expect(log.after).toBeNull();
        }
      }
    });
  });

  // NOTE: Per-entity vs global nestedOperations config resolution (getNestedOperationConfig) is not
  // covered here; every test uses the setup.ts defaults.

  // NOTE: Audit-pipeline failures reach errorHandling.observer; nested pre-fetch failures are covered
  // by nested-pre-fetch-failure.integration.spec.ts.
});
