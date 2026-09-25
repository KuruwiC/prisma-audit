import type { AuditContext } from '@kuruwic/db-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createTestContext, disposeTestContext, type TestContext } from './helpers/setup.js';

describe('Nested ConnectOrCreate Operations', () => {
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

  describe('Create Path (record does not exist)', () => {
    it('should create audit log with action=create when connectOrCreate creates new Tag (DEEP NESTED)', async () => {
      // Deep nesting (postTags.create.tag.connectOrCreate) is detected recursively

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
          },
        });
      });

      const tag = await context.prisma.tag.findUnique({ where: { name: 'typescript' } });
      expect(tag).not.toBeNull();

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
          include: { profile: true },
        });
      });

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile).not.toBeNull();
      expect(profile?.bio).toBe('New bio');

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

      const jsTag = await context.prisma.tag.findUnique({ where: { name: 'javascript' } });
      const tsTag = await context.prisma.tag.findUnique({ where: { name: 'typescript' } });
      expect(jsTag).not.toBeNull();
      expect(tsTag).not.toBeNull();

      // Verify: Only typescript tag should have create audit log (javascript was connected)
      const jsTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: existingTag.id, action: 'create' },
      });
      expect(jsTagLogs.length).toBe(0);

      const tsTagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tsTag?.id, action: 'create' },
      });
      expect(tsTagLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Connect Path (record exists)', () => {
    it('should NOT create audit log when connectOrCreate connects to existing record', async () => {
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

      const tagLogsBeforeConnect = await context.prisma.auditLog.count({
        where: { entityType: 'Tag', entityId: existingTag.id },
      });

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
      expect(tag?.id).toBe(existingTag.id);

      const tagLogsAfterConnect = await context.prisma.auditLog.count({
        where: { entityType: 'Tag', entityId: existingTag.id },
      });

      // Verify: No new Tag audit logs were created (connectOrCreate connected to existing)
      expect(tagLogsAfterConnect).toBe(tagLogsBeforeConnect);
    });

    it('should NOT create audit log for Profile when connectOrCreate connects to existing record', async () => {
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
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      const finalLogCount = await context.prisma.auditLog.count();
      expect(finalLogCount).toBe(initialLogCount);

      const tag = await context.prisma.tag.findUnique({ where: { name: 'typescript' } });
      expect(tag).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle connectOrCreate with complex where clause', async () => {
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

      const tag = await context.prisma.tag.findUnique({ where: { name: 'vue' } });
      expect(tag).not.toBeNull();

      const tagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tag?.id, action: 'create' },
      });
      expect(tagLogs.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle deep nested connectOrCreate operations', async () => {
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

      const tag = await context.prisma.tag.findUnique({ where: { name: 'angular' } });
      expect(tag).not.toBeNull();

      const tagLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Tag', entityId: tag?.id, action: 'create' },
      });
      expect(tagLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Nested Create via Auto-Injection (no include)', () => {
    it('should create an audit log for a nested Post create inside a top-level User update without an include clause', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: { email: 'nested-create-no-include@example.com', name: 'Nested Create User', password: 'secret123' },
        });
      });

      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Nested Create User Updated',
            posts: { create: [{ title: 'Auto-injected Post', content: 'nc' }] },
          },
          // No include clause — the extension must auto-inject one to detect the nested create
        });
      });

      const post = await context.prisma.post.findFirst({ where: { title: 'Auto-injected Post' } });
      expect(post).not.toBeNull();

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'create', entityId: post?.id },
      });
      expect(postLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
  describe('the writes nested in the create data', () => {
    // A connectOrCreate runs the writes nested in its `create` data only when it creates its row.

    const connectOrCreateAuthor = (email: string) =>
      context.provider.runAsync(testActor, () =>
        context.prisma.post.create({
          data: {
            title: 'Post',
            author: {
              connectOrCreate: {
                where: { email },
                create: { email, name: 'Author', password: 'secret123', profile: { create: { bio: 'new bio' } } },
              },
            },
          },
        }),
      );

    it('records nothing for them when the connectOrCreate connects an existing row', async () => {
      const user = await context.basePrisma.user.create({
        data: { email: 'existing-author@example.com', name: 'Author', password: 'secret123' },
      });
      await context.basePrisma.profile.create({ data: { userId: user.id, bio: 'existing bio' } });

      await connectOrCreateAuthor('existing-author@example.com');

      expect(await context.basePrisma.auditLog.findMany({ where: { entityType: 'Profile' } })).toEqual([]);
      expect(await context.basePrisma.auditLog.count({ where: { entityType: 'Post', action: 'create' } })).toBe(2);
    });

    it('records them when the connectOrCreate creates its row', async () => {
      await connectOrCreateAuthor('new-author@example.com');

      const profileLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Profile', aggregateType: 'Profile' },
      });
      expect(profileLogs.map((log) => [log.action, (log.after as { bio?: string }).bio])).toEqual([
        ['create', 'new bio'],
      ]);
    });
  });
});
