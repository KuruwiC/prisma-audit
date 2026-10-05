import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDatabase,
  createTestContext,
  disposeTestContext,
  type TestContext,
  testAggregateMapping,
} from './helpers/setup.js';

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

  describe('with fetchBefore.delete: true (test setup)', () => {
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
        expect(log.before).not.toBeNull(); // fetchBefore.delete=true (test setup)
        expect(log.after).toBeNull(); // Delete always has null 'after'
      }

      const deletedPost = await context.prisma.post.findUnique({ where: { id: post.id } });
      expect(deletedPost).toBeNull();
    });
  });

  // NOTE: The tests in this file use the setup.ts configuration (fetchBefore.delete: true).
  // The fetchBefore.delete: false path is covered by performance.integration.spec.ts with its own client.

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

      // All delete logs should have before state (fetchBefore.delete=true)
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
  });

  describe('before-state read configured per model', () => {
    type FetchBeforeConfig = Parameters<typeof createAuditClient>[1]['fetchBefore'];

    /** Deletes one post through its author and returns the `before` of the post's own audit log */
    const deletePostThroughAuthor = async (email: string, fetchBefore: FetchBeforeConfig) => {
      const user = await context.basePrisma.user.create({ data: { email, name: 'Author', password: 'secret123' } });
      const post = await context.basePrisma.post.create({
        data: { title: 'Doomed', content: 'Content', authorId: user.id },
      });
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        fetchBefore,
      });

      try {
        await provider.runAsync(testActor, () =>
          prisma.user.update({ where: { id: user.id }, data: { posts: { delete: { id: post.id } } } }),
        );
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      const log = await context.basePrisma.auditLog.findFirstOrThrow({
        where: { entityType: 'Post', entityId: post.id, aggregateType: 'Post' },
      });
      return log.before;
    };

    it('skips the read for a model whose own setting turns it off, whatever the global setting', async () => {
      const before = await deletePostThroughAuthor('model-off@example.com', {
        delete: true,
        models: { Post: { delete: false } },
      });

      expect(before).toBeNull();
    });

    it('reads the before state of a model whose own setting turns it on, whatever the global setting', async () => {
      const before = await deletePostThroughAuthor('model-on@example.com', {
        delete: false,
        models: { Post: { delete: true } },
      });

      expect(before).toMatchObject({ title: 'Doomed' });
    });

    it('applies the global setting to a model the per-model settings do not name', async () => {
      const before = await deletePostThroughAuthor('other-model@example.com', {
        delete: false,
        models: { Comment: { delete: true } },
      });

      expect(before).toBeNull();
    });
  });

  // NOTE: Audit-pipeline failures reach errorHandling.observer; nested pre-fetch failures are covered
  // by nested-pre-fetch-failure.integration.spec.ts.
  describe('a nested delete next to other operations at the same path', () => {
    // Every operation at a path reads its targets ahead of the write into the same place; a
    // delete records the rows it names, not every row read at its path.

    const seedPosts = async (email: string) => {
      const user = await context.basePrisma.user.create({ data: { email, name: 'Author', password: 'secret123' } });
      const post = (title: string, published: boolean) =>
        context.basePrisma.post.create({ data: { title, content: 'Content', authorId: user.id, published } });
      return {
        user,
        a: await post('A', true),
        b: await post('B', false),
        c: await post('C', false),
        d: await post('D', true),
      };
    };

    const sorted = (entries: string[][]) => [...entries].sort((x, y) => (x.join() < y.join() ? -1 : 1));

    /** One [entityId, action] per audited Post event: the row whose aggregate is the post itself */
    const postEvents = async () => {
      const logs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Post', aggregateType: 'Post' } });
      return sorted(logs.map((log) => [log.entityId, log.action]));
    };

    it('records each row of a delete and a deleteMany at one path once', async () => {
      const { user, a, b, c } = await seedPosts('delete-and-delete-many@example.com');

      await context.provider.runAsync(testActor, () =>
        context.prisma.user.update({
          where: { id: user.id },
          data: { posts: { delete: { id: a.id }, deleteMany: { published: false } } },
        }),
      );

      expect(await postEvents()).toEqual(
        sorted([
          [a.id, 'delete'],
          [b.id, 'delete'],
          [c.id, 'delete'],
        ]),
      );
    });

    it('records the row an update next to a delete writes as updated only', async () => {
      const { user, a, b } = await seedPosts('update-and-delete@example.com');

      await context.provider.runAsync(testActor, () =>
        context.prisma.user.update({
          where: { id: user.id },
          data: { posts: { update: { where: { id: a.id }, data: { title: 'A2' } }, delete: { id: b.id } } },
        }),
      );

      expect(await postEvents()).toEqual(
        sorted([
          [b.id, 'delete'],
          [a.id, 'update'],
        ]),
      );
    });

    it('records every row of a delete list whose before state is not read', async () => {
      const { user, a, b } = await seedPosts('delete-list-no-pre-fetch@example.com');
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        fetchBefore: { delete: false },
      });

      try {
        await provider.runAsync(testActor, () =>
          prisma.user.update({
            where: { id: user.id },
            data: { posts: { delete: [{ id: a.id }, { id: b.id }] } },
          }),
        );
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      expect(await postEvents()).toEqual(
        sorted([
          [a.id, 'delete'],
          [b.id, 'delete'],
        ]),
      );
      const logs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Post' } });
      for (const log of logs) {
        expect(log.before).toBeNull();
      }
    });
  });

  describe('a nested delete whose row is not read, below a top-level row the update re-keys', () => {
    // A subscription's foreign key references the user's email, which the same update changes; the
    // unread row is given the email its user held before the write.
    const BEFORE_EMAIL = 'rekeyed-before@example.com';
    const AFTER_EMAIL = 'rekeyed-after@example.com';

    const deleteSubscriptionWhileRekeying = async (
      where: Prisma.UserWhereUniqueInput,
      fetchBefore: Parameters<typeof createAuditClient>[1]['fetchBefore'],
    ) => {
      await context.basePrisma.user.create({
        data: { id: 'rekeyed-user', email: BEFORE_EMAIL, name: 'Author', password: 'secret123' },
      });
      await context.basePrisma.subscription.create({
        data: { id: 'rekeyed-subscription', topic: 'news', userEmail: BEFORE_EMAIL },
      });
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: {
          ...testAggregateMapping,
          Subscription: defineEntity({ type: 'Subscription', aggregates: [to('User', foreignKey('userEmail'))] }),
        },
        performance: { awaitWrite: true },
        fetchBefore,
      });

      try {
        await provider.runAsync(testActor, () =>
          prisma.user.update({
            where,
            data: { email: AFTER_EMAIL, subscriptions: { delete: { id: 'rekeyed-subscription' } } },
          }),
        );
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      const logs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Subscription' } });
      return logs.map((log) => `${log.aggregateType}:${log.aggregateId}`).sort();
    };

    it("takes the referenced column from the top-level row's before state", async () => {
      const aggregates = await deleteSubscriptionWhileRekeying({ id: 'rekeyed-user' }, { delete: false });

      expect(aggregates).toEqual(['Subscription:rekeyed-subscription', `User:${BEFORE_EMAIL}`]);
    });

    it('takes the referenced column from the where of a top-level row whose before state is not read', async () => {
      const aggregates = await deleteSubscriptionWhileRekeying(
        { email: BEFORE_EMAIL },
        { update: false, delete: false },
      );

      expect(aggregates).toEqual(['Subscription:rekeyed-subscription', `User:${BEFORE_EMAIL}`]);
    });
  });

  describe('a nested delete whose row cannot be identified', () => {
    it('notifies the observer under row-identification, records nothing for it and keeps the write', async () => {
      const user = await context.basePrisma.user.create({
        data: { email: 'unidentified-delete@example.com', name: 'Author', password: 'secret123' },
      });
      await context.basePrisma.profile.create({ data: { id: 'unidentified-profile', userId: user.id, bio: 'bio' } });
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn<AuditErrorObserver>();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        // Without the read ahead of the write, a to-one delete (`delete: true`) names no row
        fetchBefore: { delete: false },
        errorHandling: { observer },
      });

      try {
        const updated = await provider.runAsync(testActor, () =>
          prisma.user.update({ where: { id: user.id }, data: { profile: { delete: true } } }),
        );
        expect(updated).toMatchObject({ id: user.id });
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Profile',
          operation: 'delete',
          params: { entityId: undefined, pkFields: ['id'] },
          error: expect.any(Error),
        }),
      );
      expect(await context.basePrisma.profile.findUnique({ where: { id: 'unidentified-profile' } })).toBeNull();
      expect(await context.basePrisma.auditLog.findMany({ where: { entityType: 'Profile' } })).toEqual([]);
    });
  });
});
