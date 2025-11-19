import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Nested ConnectOrCreate Operations (Phase 2)', () => {
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

  describe('Create Path (record does not exist)', () => {
    it('should create audit log with action=create when connectOrCreate creates new Tag (DEEP NESTED)', async () => {
      // NOTE: This uses deep nesting (postTags.create.tag.connectOrCreate)
      // which is now supported via recursive detection

      // Setup: Create post without tags
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

      // Action: ConnectOrCreate with non-existing tag (should create)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connectOrCreate: {
                    where: { name: 'typescript' },
                    create: { name: 'typescript' },
                  },
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

      // Verify: Tag should be created
      const tag = await context.prisma.tag.findUnique({ where: { name: 'typescript' } });
      expect(tag).not.toBeNull();

      // Verify: Audit log should have action=create for Tag
      const tagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tag?.id },
      });

      expect(tagLogs.length).toBeGreaterThanOrEqual(1);
      const createLog = tagLogs.find((log: { action: string }) => log.action === 'create');
      expect(createLog).toBeDefined();
      expect(createLog?.before).toBeNull(); // Create always has null 'before'
      expect(createLog?.after).not.toBeNull();
      const after = createLog?.after as { name?: string };
      expect(after.name).toBe('typescript');
    });

    it('should create audit log for Profile when connectOrCreate creates new record', async () => {
      // Setup: Create user without profile
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: ConnectOrCreate profile (create path, since no profile exists)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            profile: {
              connectOrCreate: {
                where: { userId: user.id },
                create: {
                  bio: 'New bio',
                },
              },
            },
          },
          include: { profile: true }, // Required for nested operation audit logging
        });
      });

      // Verify: Profile should be created
      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile).not.toBeNull();
      expect(profile?.bio).toBe('New bio');

      // Verify: Audit log should have action=create
      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile?.id },
      });

      expect(profileLogs.length).toBeGreaterThanOrEqual(1);
      const createLog = profileLogs.find((log: { action: string }) => log.action === 'create');
      expect(createLog).toBeDefined();
      expect(createLog?.before).toBeNull();
      expect(createLog?.after).not.toBeNull();
    });

    it('should handle multiple connectOrCreate operations with mixed create/connect paths', async () => {
      // Setup: Create existing tag
      const existingTag = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.tag.create({
          data: { name: 'javascript' },
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

      // Action: ConnectOrCreate with one existing tag and one new tag
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: [
                {
                  tag: {
                    connectOrCreate: {
                      where: { name: 'javascript' }, // Existing - should connect (no audit)
                      create: { name: 'javascript' },
                    },
                  },
                },
                {
                  tag: {
                    connectOrCreate: {
                      where: { name: 'typescript' }, // New - should create (audit)
                      create: { name: 'typescript' },
                    },
                  },
                },
              ],
            },
          },
          include: {
            postTags: {
              include: { tag: true },
            },
          },
        });
      });

      // Verify: Both tags should exist
      const jsTag = await context.prisma.tag.findUnique({ where: { name: 'javascript' } });
      const tsTag = await context.prisma.tag.findUnique({ where: { name: 'typescript' } });
      expect(jsTag).not.toBeNull();
      expect(tsTag).not.toBeNull();

      // Verify: Only typescript tag should have create audit log (javascript was connected)
      const jsTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: existingTag.id, action: 'create' },
      });
      expect(jsTagLogs.length).toBe(0); // No new create log for connected tag

      const tsTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tsTag?.id, action: 'create' },
      });
      expect(tsTagLogs.length).toBeGreaterThanOrEqual(1); // Create log for new tag
    });
  });

  describe('Connect Path (record exists)', () => {
    it('should NOT create audit log when connectOrCreate connects to existing record', async () => {
      // Setup: Create existing tag
      const existingTag = await context.provider.runAsync(testActor, async () => {
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

      // Count Tag logs before PostTag creation
      const tagLogsBeforeConnect = await context.prisma.auditLog.count({
        where: { entityType: 'Tag', entityId: existingTag.id },
      });

      // Action: ConnectOrCreate with existing tag (should connect, no new audit log)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connectOrCreate: {
                    where: { name: 'react' },
                    create: { name: 'react' },
                  },
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

      // Verify: Tag was connected, not created
      const tag = await context.prisma.tag.findUnique({ where: { name: 'react' } });
      expect(tag?.id).toBe(existingTag.id); // Same tag instance

      // Count Tag logs after PostTag creation
      const tagLogsAfterConnect = await context.prisma.auditLog.count({
        where: { entityType: 'Tag', entityId: existingTag.id },
      });

      // Verify: No new Tag audit logs were created (connectOrCreate connected to existing)
      // The count should be the same before and after the connectOrCreate operation
      expect(tagLogsAfterConnect).toBe(tagLogsBeforeConnect);
    });

    it('should NOT create audit log for Profile when connectOrCreate connects to existing record', async () => {
      // Setup: Create user with profile
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Original bio',
              },
            },
          },
          include: { profile: true },
        });
      });

      const profileId = user.profile?.id;
      expect(profileId).toBeDefined();

      await context.prisma.auditLog.deleteMany();

      // Action: ConnectOrCreate profile (connect path, profile already exists)
      // Note: This may throw error in practice (unique constraint), but tests the logic
      const result = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: {
            profile: {
              connectOrCreate: {
                where: { userId: user.id },
                create: {
                  bio: 'Should not be created',
                },
              },
            },
          },
          include: { profile: true },
        });
      });

      // Verify: Same profile instance (connected, not created)
      expect(result.profile?.id).toBe(profileId);

      // Verify: No audit log for Profile (no create/update occurred)
      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profileId },
      });
      expect(profileLogs.length).toBe(0);
    });
  });

  describe('Transaction Atomicity', () => {
    it('should NOT create audit log if connectOrCreate fails in transaction', async () => {
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

      const initialLogCount = await context.prisma.auditLog.count();

      // Action: ConnectOrCreate in transaction that throws error
      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.post.update({
            where: { id: post.id },
            data: {
              postTags: {
                create: {
                  tag: {
                    connectOrCreate: {
                      where: { name: 'typescript' },
                      create: { name: 'typescript' },
                    },
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

      // Verify: Tag was not created
      const tag = await context.prisma.tag.findUnique({ where: { name: 'typescript' } });
      expect(tag).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle connectOrCreate with complex where clause', async () => {
      // Setup: Create user and post
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
            content: 'Test content',
            authorId: user.id,
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: ConnectOrCreate with unique constraint (name)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              create: {
                tag: {
                  connectOrCreate: {
                    where: { name: 'vue' },
                    create: { name: 'vue' },
                  },
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

      // Verify: Tag was created
      const tag = await context.prisma.tag.findUnique({ where: { name: 'vue' } });
      expect(tag).not.toBeNull();

      // Verify: Audit log exists
      const tagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tag?.id, action: 'create' },
      });
      expect(tagLogs.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle deep nested connectOrCreate operations', async () => {
      // Setup: Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Deep nested connectOrCreate (User -> Post -> PostTag -> Tag)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              create: {
                title: 'New Post',
                content: 'Content',
                postTags: {
                  create: {
                    tag: {
                      connectOrCreate: {
                        where: { name: 'angular' },
                        create: { name: 'angular' },
                      },
                    },
                  },
                },
              },
            },
          },
          include: {
            posts: {
              include: {
                postTags: {
                  include: { tag: true },
                },
              },
            },
          },
        });
      });

      // Verify: Tag was created
      const tag = await context.prisma.tag.findUnique({ where: { name: 'angular' } });
      expect(tag).not.toBeNull();

      // Verify: Audit log exists for Tag
      const tagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tag?.id, action: 'create' },
      });
      expect(tagLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
