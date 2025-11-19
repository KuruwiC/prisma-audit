import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Nested Connect Operations (Phase 2)', () => {
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

  describe('Many-to-Many Relations (Join Table)', () => {
    it('should create audit log for PostTag when connecting existing Tag to Post', async () => {
      // Setup: Create existing tag and post separately
      const tag = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.tag.create({
          data: { name: 'typescript' },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            author: {
              create: {
                email: 'author@example.com',
                name: 'Author',
                password: 'secret123',
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Connect existing tag to post (creates PostTag join record)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connect: { id: tag.id },
                },
              },
            },
          },
          include: {
            postTags: {
              include: { tag: true },
            },
          }, // Required for nested operation audit logging
        });
      });

      // Verify: PostTag join record was created
      const postTag = await context.prisma.postTag.findFirst({
        where: { postId: post.id, tagId: tag.id },
      });
      expect(postTag).not.toBeNull();

      // Verify: Audit log should exist for PostTag create
      const postTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostTag', entityId: postTag?.id, action: 'create' },
      });

      expect(postTagLogs.length).toBeGreaterThanOrEqual(1);
      const createLog = postTagLogs[0];
      expect(createLog.before).toBeNull(); // Create always has null 'before'
      expect(createLog.after).not.toBeNull();
    });

    it('should NOT create audit log for Tag entity itself when connecting (only join table)', async () => {
      // Setup: Create existing tag and post
      const tag = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.tag.create({
          data: { name: 'react' },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            author: {
              create: {
                email: 'author@example.com',
                name: 'Author',
                password: 'secret123',
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Connect tag to post
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connect: { id: tag.id },
                },
              },
            },
          },
          include: {
            postTags: {
              include: { tag: true },
            },
          },
        });
      });

      // Verify: No audit log for Tag entity (it was not modified)
      const tagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tag.id },
      });
      expect(tagLogs.length).toBe(0); // Tag itself was not created/updated
    });

    it('should create multiple PostTag audit logs when connecting multiple tags', async () => {
      // Setup: Create multiple tags and a post
      const tags = await context.provider.runAsync(testActor, async () => {
        return await Promise.all([
          context.prisma.tag.create({ data: { name: 'javascript' } }),
          context.prisma.tag.create({ data: { name: 'typescript' } }),
          context.prisma.tag.create({ data: { name: 'react' } }),
        ]);
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            author: {
              create: {
                email: 'author@example.com',
                name: 'Author',
                password: 'secret123',
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Connect all tags to post
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: tags.map((tag: { id: string }) => ({
                tag: {
                  connect: { id: tag.id },
                },
              })),
            },
          },
          include: {
            postTags: {
              include: { tag: true },
            },
          },
        });
      });

      // Verify: All PostTag join records were created
      const postTags = await context.prisma.postTag.findMany({
        where: { postId: post.id },
      });
      expect(postTags.length).toBe(3);

      // Verify: Audit logs exist for all PostTag creates
      const postTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostTag', action: 'create' },
      });
      expect(postTagLogs.length).toBeGreaterThanOrEqual(3);

      // Verify: All PostTag IDs are logged
      const loggedIds = postTagLogs.map((log: { entityId: string }) => log.entityId);
      for (const postTag of postTags) {
        expect(loggedIds).toContain(postTag.id);
      }
    });
  });

  describe('One-to-One Relations', () => {
    it('should NOT create audit log when connecting to existing Profile (1:1)', async () => {
      // Setup: Create user and profile separately
      const user1 = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user1@example.com',
            name: 'User 1',
            password: 'secret123',
          },
        });
      });

      const profile = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.profile.create({
          data: {
            userId: user1.id,
            bio: 'Bio for user 1',
          },
        });
      });

      // Create another user to "connect" to the profile (edge case scenario)
      // Note: In practice, this may fail due to unique constraint (userId)
      // This test documents expected behavior for 1:1 relations

      await context.prisma.auditLog.deleteMany();

      // Action: Attempt to connect (may not be practical for 1:1 with unique constraint)
      // Instead, test that existing profile connection doesn't create new logs
      const result = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({
          where: { id: user1.id },
          data: {
            profile: {
              connect: { id: profile.id },
            },
          },
          include: { profile: true },
        });
      });

      // Verify: Same profile instance (no new record)
      expect(result.profile?.id).toBe(profile.id);

      // Verify: No new audit log (profile was not created/updated)
      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile.id },
      });
      expect(profileLogs.length).toBe(0);
    });
  });

  describe('One-to-Many Relations', () => {
    it('should NOT create audit log when connecting Comment to existing Post (1:N)', async () => {
      // Setup: Create post and comment separately
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
            title: 'Test Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      const comment = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.comment.create({
          data: {
            content: 'Test comment',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Connect comment to post (already connected, no change)
      const result = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.update({
          where: { id: post.id },
          data: {
            comments: {
              connect: { id: comment.id },
            },
          },
          include: { comments: true },
        });
      });

      // Verify: Same comment instance
      expect(result.comments.some((c: { id: string }) => c.id === comment.id)).toBe(true);

      // Verify: No new audit log (comment was not created/updated)
      const commentLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id },
      });
      expect(commentLogs.length).toBe(0);
    });
  });

  describe('Transaction Atomicity', () => {
    it('should NOT create audit log if connect operation fails in transaction', async () => {
      // Setup: Create tag and post
      const tag = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.tag.create({
          data: { name: 'vue' },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            author: {
              create: {
                email: 'author@example.com',
                name: 'Author',
                password: 'secret123',
              },
            },
          },
        });
      });

      const initialLogCount = await context.prisma.auditLog.count();

      // Action: Connect in transaction that throws error
      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.post.update({
            where: { id: post.id },
            data: {
              postTags: {
                create: {
                  tag: {
                    connect: { id: tag.id },
                  },
                },
              },
            },
            include: {
              postTags: {
                include: { tag: true },
              },
            },
          });
          // Intentionally throw error
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      // Verify: No new audit logs created
      const finalLogCount = await context.prisma.auditLog.count();
      expect(finalLogCount).toBe(initialLogCount);

      // Verify: PostTag was not created
      const postTag = await context.prisma.postTag.findFirst({
        where: { postId: post.id, tagId: tag.id },
      });
      expect(postTag).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle connect with non-existent ID gracefully', async () => {
      // Setup: Create post
      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            author: {
              create: {
                email: 'author@example.com',
                name: 'Author',
                password: 'secret123',
              },
            },
          },
        });
      });

      // Action: Try to connect with non-existent tag ID
      const connectPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connect: { id: 'non-existent-id' },
                },
              },
            },
          },
          include: {
            postTags: {
              include: { tag: true },
            },
          },
        });
      });

      // Verify: Should throw error (foreign key constraint)
      await expect(connectPromise).rejects.toThrow();

      // Verify: No audit log created (operation failed)
      const postTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostTag', action: 'create' },
      });
      expect(postTagLogs.length).toBe(0);
    });

    it('should handle duplicate connect attempts (idempotency)', async () => {
      // Setup: Create tag and post with existing connection
      const tag = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.tag.create({
          data: { name: 'svelte' },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            author: {
              create: {
                email: 'author@example.com',
                name: 'Author',
                password: 'secret123',
              },
            },
            postTags: {
              create: {
                tag: {
                  connect: { id: tag.id },
                },
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Try to connect same tag again (should fail due to unique constraint)
      const duplicateConnectPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connect: { id: tag.id },
                },
              },
            },
          },
          include: {
            postTags: {
              include: { tag: true },
            },
          },
        });
      });

      // Verify: Should throw error (unique constraint violation)
      await expect(duplicateConnectPromise).rejects.toThrow();

      // Verify: No new audit log (operation failed)
      const postTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostTag', action: 'create' },
      });
      expect(postTagLogs.length).toBe(0);
    });
  });
});
