import type { AuditContext } from '@kuruwic/db-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createTestContext, disposeTestContext, type TestContext } from './helpers/setup.js';

describe('Nested Upsert Operations', () => {
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

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile?.id },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);
      for (const log of profileLogs) {
        expect(log.action).toBe('create');
        expect(log.before).toBeNull(); // Create always has null 'before'
        expect(log.after).not.toBeNull();
      }
    });

    it('should handle nested upsert create with multiple fields', async () => {
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
                  bio: 'Biography',
                  website: 'https://example.com',
                },
                update: {
                  bio: 'Updated',
                },
              },
            },
          },
          include: { profile: true },
        });
      });

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile?.bio).toBe('Biography');
      expect(profile?.website).toBe('https://example.com');

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile' },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);
      const logWithData = profileLogs.find((log: { after: unknown }) => {
        const after = log.after as { bio?: string; website?: string };
        return after.bio === 'Biography' && after.website === 'https://example.com';
      });
      expect(logWithData).toBeDefined();
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
      expect(profile1Logs.some((log: { action: string }) => log.action === 'update')).toBe(true);

      const profile2Logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile2?.id },
      });
      expect(profile2Logs.some((log: { action: string }) => log.action === 'create')).toBe(true);
    });
  });

  describe('Transaction Atomicity', () => {
    it('should NOT create audit log if upsert fails in transaction', async () => {
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

      const initialLogCount = await context.prisma.auditLog.count();

      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.update({
            where: { id: user.id },
            data: {
              profile: {
                upsert: {
                  create: { bio: 'Should not be created' },
                  update: { bio: 'Should not be updated' },
                },
              },
            },
            include: { profile: true },
          });
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      const finalLogCount = await context.prisma.auditLog.count();
      expect(finalLogCount).toBe(initialLogCount);

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile?.bio).toBe('Original bio');
    });

    it('should roll back upsert create if transaction fails', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const transactionPromise = context.provider.runAsync(testActor, async () => {
        return context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.update({
            where: { id: user.id },
            data: {
              profile: {
                upsert: {
                  create: { bio: 'Should be rolled back' },
                  update: { bio: 'Should not be used' },
                },
              },
            },
            include: { profile: true },
          });
          throw new Error('Rollback test');
        });
      });

      await expect(transactionPromise).rejects.toThrow('Rollback test');

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent upserts on same record', async () => {
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

      // One may fail due to unique constraint (race condition)
      const results = await Promise.allSettled([
        context.provider.runAsync(testActor, async () => {
          return context.prisma.user.update({
            where: { id: user.id },
            data: {
              profile: {
                upsert: {
                  create: { bio: 'Bio 1' },
                  update: { bio: 'Bio 1 Updated' },
                },
              },
            },
            include: { profile: true },
          });
        }),
        context.provider.runAsync(testActor, async () => {
          return context.prisma.user.update({
            where: { id: user.id },
            data: {
              profile: {
                upsert: {
                  create: { bio: 'Bio 2' },
                  update: { bio: 'Bio 2 Updated' },
                },
              },
            },
            include: { profile: true },
          });
        }),
      ]);

      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      const profile = await context.prisma.profile.findUnique({ where: { userId: user.id } });
      expect(profile).not.toBeNull();

      // Note: Final bio depends on race condition
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
      expect(user1Profile).toBeNull();

      const user3Profile = await context.prisma.profile.findUnique({ where: { userId: user3.id } });
      expect(user3Profile).toBeNull();
    });

    it('should correctly identify which profile to create when multiple users exist', async () => {
      const [user1, user2, user3] = await context.provider.runAsync(testActor, async () => {
        return Promise.all([
          context.prisma.user.create({
            data: {
              email: 'user1@example.com',
              name: 'User 1',
              password: 'secret123',
            },
          }),
          context.prisma.user.create({
            data: {
              email: 'user2@example.com',
              name: 'User 2',
              password: 'secret123',
            },
          }),
          context.prisma.user.create({
            data: {
              email: 'user3@example.com',
              name: 'User 3',
              password: 'secret123',
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
                create: { bio: 'New Bio for User 2' },
                update: { bio: 'Should not be used' },
              },
            },
          },
          include: { profile: true },
        });
      });

      const user2Profile = await context.prisma.profile.findUnique({ where: { userId: user2.id } });
      expect(user2Profile).not.toBeNull();
      expect(user2Profile?.bio).toBe('New Bio for User 2');

      const user1Profile = await context.prisma.profile.findUnique({ where: { userId: user1.id } });
      expect(user1Profile).toBeNull();

      const user3Profile = await context.prisma.profile.findUnique({ where: { userId: user3.id } });
      expect(user3Profile).toBeNull();

      const profileLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: user2Profile?.id, action: 'create' },
      });

      // Profile has 2 logs: Profile aggregate + User aggregate
      expect(profileLogs).toHaveLength(2);
    });
  });

  // NOTE: Every test here uses the setup.ts defaults; the per-model vs global resolution of
  // fetchBefore is covered by nested-delete.integration.spec.ts.

  // NOTE: Audit-pipeline failures reach errorHandling.observer; nested pre-fetch failures are covered
  // by nested-pre-fetch-failure.integration.spec.ts.
});
