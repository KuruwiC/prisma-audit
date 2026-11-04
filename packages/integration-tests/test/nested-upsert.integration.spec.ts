import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { setupTestContext } from './helpers/setup.js';

describe('Nested Upsert Operations', () => {
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
    it('should create audit log with action=create when record does not exist', async () => {
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
              upsert: {
                create: {
                  bio: 'New bio',
                  website: 'https://example.com',
                },
                update: {
                  bio: 'Updated bio',
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
      expect(profile?.website).toBe('https://example.com');

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile?.id },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);
      for (const log of profileLogs) {
        expect(log.action).toBe('create');
        expect(log.before).toBeNull(); // Create always has null 'before'
        expect(log.after).toMatchObject({ bio: 'New bio', website: 'https://example.com' });
      }
    });

    it('should create audit log with action=create for a nested to-one upsert under a row whose optional foreign key is null', async () => {
      const user = await context.basePrisma.user.create({
        data: { email: 'user@example.com', name: 'User', password: 'secret123' },
      });
      await context.basePrisma.label.create({ data: { id: 'l-null', name: 'loose' } });

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.label.update({
          where: { id: 'l-null' },
          data: {
            post: {
              upsert: {
                create: { id: 'p-upserted', title: 'Created', author: { connect: { id: user.id } } },
                update: { title: 'Updated' },
              },
            },
          },
        });
      });

      expect(await context.basePrisma.label.findUnique({ where: { id: 'l-null' } })).toMatchObject({
        postId: 'p-upserted',
      });
      const postLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: 'p-upserted' },
      });
      // Post has 2 logs: Post aggregate + User aggregate
      expect(postLogs).toHaveLength(2);
      for (const log of postLogs) {
        expect(log.action).toBe('create');
        expect(log.before).toBeNull();
        expect(log.after).toMatchObject({ id: 'p-upserted', title: 'Created' });
      }
      const labelLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Label', entityId: 'l-null' },
      });
      expect(labelLogs).toHaveLength(1);
      expect(labelLogs[0]).toMatchObject({ action: 'update', changes: { postId: { old: null, new: 'p-upserted' } } });
    });
  });

  describe('Update Path (record exists)', () => {
    it('should create audit log with action=update when record exists', async () => {
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

      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            profile: {
              upsert: {
                create: {
                  bio: 'Should not be used',
                },
                update: {
                  bio: 'Updated bio',
                },
              },
            },
          },
          include: { profile: true },
        });
      });

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile?.bio).toBe('Updated bio');

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile?.id, action: 'update' },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);
      for (const log of profileLogs) {
        expect(log.action).toBe('update');
        // Upsert always pre-fetches to pick its branch, so before holds the original row
        expect(log.before).not.toBeNull();
        const before = log.before as { bio?: string };
        expect(before.bio).toBe('Original bio');
      }
    });

    it('should handle nested upsert update with partial fields', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Original bio',
                website: 'https://original.com',
              },
            },
          },
          include: { profile: true },
        });
      });

      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            profile: {
              upsert: {
                create: {
                  bio: 'Should not be used',
                },
                update: {
                  bio: 'Updated bio',
                },
              },
            },
          },
          include: { profile: true },
        });
      });

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile?.bio).toBe('Updated bio');
      expect(profile?.website).toBe('https://original.com');

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile?.id },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);
      for (const log of profileLogs) {
        expect(log.action).toBe('update');
        // The untouched website is not a change; updatedAt moves with every write
        const changes = log.changes as Record<string, unknown>;
        expect(Object.keys(changes).sort()).toEqual(['bio', 'updatedAt']);
        expect(changes.bio).toEqual({ old: 'Original bio', new: 'Updated bio' });
      }
    });
  });

  // NOTE: Upsert always pre-fetches to decide between create and update, regardless of
  // fetchBefore, so these tests cover its pre-fetch under the setup.ts defaults.

  describe('Mixed Create and Update', () => {
    it('should handle upsert operations with different paths in same transaction', async () => {
      const user1 = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user1@example.com',
            name: 'User 1',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Existing bio',
              },
            },
          },
          include: { profile: true },
        });
      });

      const user2 = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user2@example.com',
            name: 'User 2',
            password: 'secret123',
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction([
          context.prisma.user.update({
            where: { id: user1.id },
            data: {
              profile: {
                upsert: {
                  create: { bio: 'Should not be used' },
                  update: { bio: 'Updated bio 1' },
                },
              },
            },
            include: { profile: true },
          }),
          context.prisma.user.update({
            where: { id: user2.id },
            data: {
              profile: {
                upsert: {
                  create: { bio: 'New bio 2' },
                  update: { bio: 'Should not be used' },
                },
              },
            },
            include: { profile: true },
          }),
        ]);
      });

      const profile1 = await context.prisma.profile.findUnique({ where: { userId: user1.id } });
      expect(profile1?.bio).toBe('Updated bio 1');

      const profile2 = await context.prisma.profile.findUnique({ where: { userId: user2.id } });
      expect(profile2?.bio).toBe('New bio 2');

      const profile1Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile1?.id },
      });
      expect(profile1Logs.map((log: { action: string }) => log.action)).toEqual(['update', 'update']);

      const profile2Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile2?.id },
      });
      expect(profile2Logs.map((log: { action: string }) => log.action)).toEqual(['create', 'create']);
    });
  });

  describe('Edge Cases', () => {
    it('should leave one profile and audit logs that match the upserts that committed, however they interleave', async () => {
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

      // Both upserts see no profile; the unique constraint on userId lets only one create it,
      // and the other either fails or sees the committed profile and updates it.
      const upsertProfile = (bio: string) =>
        context.provider.runAsync(testActor, async () => {
          return context.prisma.user.update({
            where: { id: user.id },
            data: {
              profile: {
                upsert: {
                  create: { bio },
                  update: { bio: `${bio} Updated` },
                },
              },
            },
            include: { profile: true },
          });
        });

      const results = await Promise.allSettled([upsertProfile('Bio 1'), upsertProfile('Bio 2')]);

      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      const profiles = await context.prisma.profile.findMany({ where: { userId: user.id } });
      expect(profiles).toHaveLength(1);
      const profile = profiles[0];

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile' },
      });

      // Every committed upsert wrote one log under each of the Profile and User aggregates, with
      // the same action; a failed one wrote none. An upsert whose read saw no profile records a
      // create even when the other's commit made Prisma update the row it found (a documented
      // limitation), so how many are creates depends on the interleaving. The first to commit
      // read no profile, so at least one is.
      const actionsUnder = (aggregateType: string) =>
        profileLogs
          .filter((log: { aggregateType: string }) => log.aggregateType === aggregateType)
          .map((log: { action: string }) => log.action)
          .sort();
      expect(profileLogs.every((log: { entityId: string }) => log.entityId === profile?.id)).toBe(true);
      expect(profileLogs).toHaveLength(2 * successCount);
      const profileActions = actionsUnder('Profile');
      expect(profileActions).toHaveLength(successCount);
      expect(actionsUnder('User')).toEqual(profileActions);
      expect(profileActions).toContain('create');
      expect(profileActions.filter((action: string) => action !== 'create' && action !== 'update')).toEqual([]);
    });
  });

  describe('Where Clause Accuracy', () => {
    it('should correctly identify which profile to update when multiple users exist', async () => {
      const [user1, user2, user3] = await context.provider.runAsync(testActor, async () => {
        return Promise.all([
          context.prisma.user.create({
            data: {
              email: 'user1@example.com',
              name: 'User 1',
              password: 'secret123',
              profile: {
                create: { bio: 'Original Bio for User 1' },
              },
            },
          }),
          context.prisma.user.create({
            data: {
              email: 'user2@example.com',
              name: 'User 2',
              password: 'secret123',
              profile: {
                create: { bio: 'Original Bio for User 2' },
              },
            },
          }),
          context.prisma.user.create({
            data: {
              email: 'user3@example.com',
              name: 'User 3',
              password: 'secret123',
              profile: {
                create: { bio: 'Original Bio for User 3' },
              },
            },
          }),
        ]);
      });

      // Clear audit logs from setup
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user2.id },
          data: {
            profile: {
              upsert: {
                create: { bio: 'Should not be used' },
                update: { bio: 'Updated Bio for User 2' },
              },
            },
          },
          include: { profile: true },
        });
      });

      const user2Profile = await context.prisma.profile.findUnique({ where: { userId: user2.id } });
      expect(user2Profile).not.toBeNull();
      expect(user2Profile?.bio).toBe('Updated Bio for User 2');

      // Only user2's profile was written: the other profiles have no logs
      const allProfileLogs = await context.prisma.auditLog.findMany({ where: { entityType: 'Profile' } });
      expect(allProfileLogs).toHaveLength(2);

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: user2Profile?.id, action: 'update' },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);

      // Verify: Before state should contain original bio for user2, not other users
      for (const profileLog of profileLogs) {
        expect(profileLog.before).not.toBeNull();
        const before = profileLog.before as { bio?: string };
        expect(before.bio).toBe('Original Bio for User 2');
      }

      const user1Profile = await context.prisma.profile.findUnique({ where: { userId: user1.id } });
      expect(user1Profile?.bio).toBe('Original Bio for User 1');

      const user3Profile = await context.prisma.profile.findUnique({ where: { userId: user3.id } });
      expect(user3Profile?.bio).toBe('Original Bio for User 3');
    });
  });

  // NOTE: Every test here uses the setup.ts defaults. An entity's own fetchBefore over the global
  // one is covered by nested-delete.integration.spec.ts (delete) and
  // nested-parent-attribution.integration.spec.ts (update).

  // NOTE: Audit-pipeline failures reach the observer; nested pre-fetch failures are covered
  // by nested-pre-fetch-failure.integration.spec.ts.
});
