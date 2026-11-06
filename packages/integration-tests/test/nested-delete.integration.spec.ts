import type { AuditContext, FetchBeforeConfig } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditObserver } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
import { createBasePrisma, setupTestContext, testEntities, withFetchBefore } from './helpers/setup.js';

describe('Nested Delete Operations', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  // NOTE: Unless a test builds its own client, it uses the setup.ts configuration (fetchBefore.delete: true).
  // The paths where the before state of a nested delete is not read are covered below by
  // 'before-state read configured per entity' and 'a nested delete next to other operations at the same path'.

  describe('Empty Results', () => {
    it('rejects a nested delete that names no post with P2017 and writes no audit row', async () => {
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

      await expect(deletePromise).rejects.toMatchObject({ code: 'P2017' });

      // The rejected operation audits nothing
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
    it('audits the deleted post and does not audit the comments the database cascades the delete to', async () => {
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

      // Comment cascades from Post (onDelete: Cascade in the schema): the database removes it
      // without a Prisma query, so only the nested delete of the post is audited
      const deletedComment = await context.prisma.comment.findUnique({ where: { id: comment.id } });
      expect(deletedComment).toBeNull();

      const logs = await context.prisma.auditLog.findMany({ orderBy: { aggregateType: 'asc' } });
      expect(
        logs.map((log: { entityType: string; entityId: string; action: string; aggregateType: string }) => [
          log.entityType,
          log.entityId,
          log.action,
          log.aggregateType,
        ]),
      ).toEqual([
        ['Post', post.id, 'delete', 'Post'],
        ['Post', post.id, 'delete', 'User'],
      ]);
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

      expect(post2Logs.map((log: { aggregateType: string }) => log.aggregateType).sort()).toEqual(['Post', 'User']);

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

  describe('before-state read configured per entity', () => {
    /** Deletes one post, through its author unless `options.topLevel`, and returns its own audit log's `before` */
    const deletePost = async (
      email: string,
      fetchBefore: FetchBeforeConfig,
      entityFetchBefore: Readonly<Record<string, FetchBeforeConfig>>,
      options: { readonly topLevel?: boolean } = {},
    ) => {
      const user = await context.basePrisma.user.create({ data: { email, name: 'Author', password: 'secret123' } });
      const post = await context.basePrisma.post.create({
        data: { title: 'Doomed', content: 'Content', authorId: user.id },
      });
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: withFetchBefore(testEntities, entityFetchBefore),
        write: { mode: 'awaited' },
        fetchBefore,
      });

      try {
        await provider.runAsync(testActor, async () => {
          if (options.topLevel) {
            await prisma.post.delete({ where: { id: post.id } });
          } else {
            await prisma.user.update({ where: { id: user.id }, data: { posts: { delete: { id: post.id } } } });
          }
        });
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      const log = await context.basePrisma.auditLog.findFirstOrThrow({
        where: { entityType: 'Post', entityId: post.id, aggregateType: 'Post' },
      });
      return log.before;
    };

    it('skips the read for an entity whose own setting turns it off, whatever the global setting', async () => {
      const before = await deletePost('model-off@example.com', { delete: true }, { Post: { delete: false } });

      expect(before).toBeNull();
    });

    it('reads the before state of an entity whose own setting turns it on, whatever the global setting', async () => {
      const before = await deletePost('model-on@example.com', { delete: false }, { Post: { delete: true } });

      expect(before).toMatchObject({ title: 'Doomed' });
    });

    it('applies the global setting to an entity without its own setting', async () => {
      const before = await deletePost('other-model@example.com', { delete: false }, { Comment: { delete: true } });

      expect(before).toBeNull();
    });

    it('applies the entity setting to a top-level delete as well', async () => {
      const before = await deletePost(
        'top-level@example.com',
        { delete: true },
        { Post: { delete: false } },
        {
          topLevel: true,
        },
      );

      expect(before).toBeNull();
    });
  });

  // NOTE: Audit-pipeline failures reach the observer; nested pre-fetch failures are covered
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
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        write: { mode: 'awaited' },
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
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: {
          ...testEntities,
          Subscription: defineEntity({ type: 'Subscription', aggregates: [to('User', foreignKey('userEmail'))] }),
        },
        write: { mode: 'awaited' },
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
    it('reports a row-identification failure in its outcome, records nothing for it and keeps the write', async () => {
      const user = await context.basePrisma.user.create({
        data: { email: 'unidentified-delete@example.com', name: 'Author', password: 'secret123' },
      });
      await context.basePrisma.profile.create({ data: { id: 'unidentified-profile', userId: user.id, bio: 'bio' } });
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn<AuditObserver>();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        write: { mode: 'awaited' },
        // Without the read ahead of the write, a to-one delete (`delete: true`) names no row
        fetchBefore: { delete: false },
        observer,
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

      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Profile',
          operation: 'delete',
          unidentified: 1,
          error: expect.objectContaining({ message: expect.stringContaining('keyFields=[id]') }),
        }),
      ]);
      expect(await context.basePrisma.profile.findUnique({ where: { id: 'unidentified-profile' } })).toBeNull();
      expect(await context.basePrisma.auditLog.findMany({ where: { entityType: 'Profile' } })).toEqual([]);
    });

    it('reports a row-identification failure in its outcome for a to-many delete named by a compound unique, records nothing for it and keeps the write', async () => {
      const user = await context.basePrisma.user.create({
        data: { email: 'unidentified-to-many@example.com', name: 'Author', password: 'secret123' },
      });
      const post = await context.basePrisma.post.create({
        data: { title: 'Titled', authorId: user.id },
      });
      const tag = await context.basePrisma.tag.create({ data: { name: 'unidentified-tag' } });
      await context.basePrisma.postTag.create({
        data: { id: 'unidentified-post-tag', postId: post.id, tagId: tag.id },
      });
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn<AuditObserver>();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        write: { mode: 'awaited' },
        // Without the read ahead of the write, a delete named by a compound unique names no primary key
        fetchBefore: { delete: false },
        observer,
      });

      try {
        const updated = await provider.runAsync(testActor, () =>
          prisma.post.update({
            where: { id: post.id },
            data: { postTags: { delete: { postId_tagId: { postId: post.id, tagId: tag.id } } } },
          }),
        );
        expect(updated).toMatchObject({ id: post.id });
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'PostTag',
          operation: 'delete',
          unidentified: 1,
          error: expect.objectContaining({ message: expect.stringContaining('keyFields=[id]') }),
        }),
      ]);
      expect(await context.basePrisma.postTag.findUnique({ where: { id: 'unidentified-post-tag' } })).toBeNull();
      expect(await context.basePrisma.auditLog.findMany({ where: { entityType: 'PostTag' } })).toEqual([]);
    });
  });
});
