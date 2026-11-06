import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { setupTestContext } from './helpers/setup.js';

describe('Nested ConnectOrCreate Operations', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Create Path (record does not exist)', () => {
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

      expect(profileLogs.map((log: { aggregateType: string }) => log.aggregateType).sort()).toEqual([
        'Profile',
        'User',
      ]);
      for (const log of profileLogs) {
        expect(log.action).toBe('create');
        expect(log.before).toBeNull();
        expect((log.after as { bio?: string }).bio).toBe('New bio');
      }
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
      expect(jsTag?.id).toBe(existingTag.id);
      expect(tsTag).not.toBeNull();

      // Only the new typescript tag is audited: javascript was connected, not written
      const tagLogs = await context.prisma.auditLog.findMany({ where: { entityType: 'Tag' } });
      expect(
        tagLogs.map((log: { entityId: string; action: string }) => ({ entityId: log.entityId, action: log.action })),
      ).toEqual([{ entityId: tsTag?.id, action: 'create' }]);
      expect(tagLogs[0]?.before).toBeNull();
      expect(tagLogs[0]?.after).toMatchObject({ name: 'typescript' });
    });
  });

  describe('Connect Path (record exists)', () => {
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

  describe('Edge Cases', () => {
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
      expect(tagLogs).toHaveLength(1);
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

  describe('a to-one connectOrCreate whose create data names another row than its WHERE', () => {
    /** One `entityId:action` per record of `entityType` (its own aggregate row), sorted */
    const recordsOf = async (entityType: string) =>
      (
        await context.basePrisma.auditLog.findMany({
          where: { entityType, aggregateType: entityType },
          select: { entityId: true, action: true },
        })
      )
        .map((log) => `${log.entityId}:${log.action}`)
        .sort();

    it('records the row it created when the foreign key is on the related row', async () => {
      await context.basePrisma.user.create({ data: { id: 'u1', email: 'u1@example.com' } });

      await context.provider.runAsync(testActor, () =>
        context.prisma.user.update({
          where: { id: 'u1' },
          data: { profile: { connectOrCreate: { where: { id: 'pr-x' }, create: { id: 'pr-b', bio: 'b' } } } },
        }),
      );

      expect(await recordsOf('Profile')).toEqual(['pr-b:create']);
    });

    it('records the row it created and the writes nested in its create data when the foreign key is on the parent row', async () => {
      await context.basePrisma.user.create({ data: { id: 'u1', email: 'u1@example.com' } });
      await context.basePrisma.post.create({ data: { id: 'p1', title: 'Post', authorId: 'u1' } });

      await context.provider.runAsync(testActor, () =>
        context.prisma.post.update({
          where: { id: 'p1' },
          data: {
            author: {
              connectOrCreate: {
                where: { id: 'u-x' },
                create: { id: 'u-b', email: 'u-b@example.com', profile: { create: { id: 'pr-u-b' } } },
              },
            },
          },
        }),
      );

      expect(await recordsOf('User')).toEqual(['u-b:create']);
      expect(await recordsOf('Profile')).toEqual(['pr-u-b:create']);
    });
  });
});
