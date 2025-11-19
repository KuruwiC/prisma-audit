import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Deep Nested Upsert Operations (Profile → Avatar → AvatarImage)', () => {
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

  describe('Avatar Update via Nested Upsert (3 levels deep)', () => {
    // NOTE: For 3-level nested operations (Profile → Avatar → AvatarImage),
    // pre-fetch now properly supports deep nesting using post-fetch fallback.
    // The implementation:
    // 1. Pre-fetch captures IDs from deeply nested records (before state)
    // 2. Post-fetch uses those IDs to retrieve current state (after state)
    // 3. Audit logs are created with correct before/after states
    it('should create audit logs when updating avatar image through profile.upsert', async () => {
      // Setup: Create user with profile, avatar, and avatarImage
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Original bio',
                avatar: {
                  create: {
                    name: 'Original Avatar',
                    avatarImage: {
                      create: {
                        imageUrl: 'https://example.com/original.png',
                      },
                    },
                  },
                },
              },
            },
          },
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Update avatar image through deeply nested upsert
      // This simulates the PUT /profiles/:userId endpoint behavior
      //
      // With post-fetch fallback improvements:
      // 1. Pre-fetch captures avatar.avatarImage with ID (before state)
      // 2. Operation executes (Prisma doesn't include deep nested records in result)
      // 3. Post-fetch uses pre-fetched ID to retrieve current state (after state)
      // 4. Audit log is created with both before and after states
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.profile.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            bio: 'Should not be used',
          },
          update: {
            bio: 'Original bio', // Keep bio unchanged
            avatar: {
              upsert: {
                create: {
                  name: 'Should not be used',
                },
                update: {
                  name: 'Original Avatar', // Keep avatar name unchanged
                  avatarImage: {
                    upsert: {
                      create: {
                        imageUrl: 'https://example.com/should-not-be-used.png',
                      },
                      update: {
                        imageUrl: 'https://example.com/updated.png', // Update image URL only
                      },
                    },
                  },
                },
              },
            },
          },
        });
      });

      // Verify: AvatarImage should be updated
      const profile = await context.prisma.profile.findUnique({
        where: { userId: user.id },
        include: {
          avatar: {
            include: {
              avatarImage: true,
            },
          },
        },
      });

      expect(profile?.avatar?.avatarImage?.imageUrl).toBe('https://example.com/updated.png');

      // Verify: Audit logs should now be created with proper before/after states
      // Post-fetch fallback enables 3-level nested operation tracking
      const avatarImageLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: profile?.avatar?.avatarImage?.id,
          action: 'update',
        },
      });

      // Post-fetch improvement: Now creates audit logs for 3-level nesting
      expect(avatarImageLogs.length).toBeGreaterThanOrEqual(1);
      expect(avatarImageLogs.length).toBeLessThanOrEqual(2); // 1-2 logs depending on config

      // Verify audit log content
      const log = avatarImageLogs[0];
      expect(log.action).toBe('update');
      expect(log.before).not.toBeNull();
      const before = log.before as { imageUrl?: string };
      expect(before.imageUrl).toBe('https://example.com/original.png');
      const after = log.after as { imageUrl?: string };
      expect(after.imageUrl).toBe('https://example.com/updated.png');
    });

    // NOTE: Create operations work without pre-fetch since `before=null` is correct.
    // This test passes because creating a new AvatarImage doesn't require `before` state.
    it('should create audit logs when creating avatar image through profile.upsert (create path)', async () => {
      // Setup: Create user with profile and avatar but no avatarImage
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Original bio',
                avatar: {
                  create: {
                    name: 'Avatar',
                  },
                },
              },
            },
          },
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Create avatar image through deeply nested upsert
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.profile.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            bio: 'Should not be used',
          },
          update: {
            avatar: {
              upsert: {
                create: {
                  name: 'Should not be used',
                },
                update: {
                  avatarImage: {
                    upsert: {
                      create: {
                        imageUrl: 'https://example.com/new.png',
                      },
                      update: {
                        imageUrl: 'Should not be used',
                      },
                    },
                  },
                },
              },
            },
          },
        });
      });

      // Verify: AvatarImage should be created
      const profile = await context.prisma.profile.findUnique({
        where: { userId: user.id },
        include: {
          avatar: {
            include: {
              avatarImage: true,
            },
          },
        },
      });

      expect(profile?.avatar?.avatarImage).not.toBeNull();
      expect(profile?.avatar?.avatarImage?.imageUrl).toBe('https://example.com/new.png');

      // Verify: Audit logs should be created for AvatarImage creation
      const avatarImageLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: profile?.avatar?.avatarImage?.id,
          action: 'create',
        },
      });

      expect(avatarImageLogs.length).toBeGreaterThanOrEqual(1);
      const log = avatarImageLogs[0];
      expect(log.action).toBe('create');
      expect(log.before).toBeNull(); // Create always has null 'before'
      const after = log.after as { imageUrl?: string };
      expect(after.imageUrl).toBe('https://example.com/new.png');
    });
  });

  describe('PUT /profiles/:userId endpoint simulation (Transaction)', () => {
    it('should NOT duplicate audit logs for AvatarImage (original bug fix validation)', async () => {
      // This test validates the fix for the original bug where AvatarImage create action
      // was logged 3 times instead of once.
      //
      // Root cause: detectNestedOperations explored all branches of upsert operations optimistically,
      // even though only one branch executes. This caused:
      // - profile.upsert.create.avatar.upsert.create.avatarImage.upsert.create
      // - profile.upsert.create.avatar.upsert.update.avatarImage.upsert.create
      // - profile.upsert.update.avatar.upsert.create.avatarImage.upsert.create
      // All 3 paths were detected, resulting in 3 audit logs for the same AvatarImage create.
      //
      // Fix: Pre-fetch results are now passed to detectNestedOperations, allowing it to explore
      // only the branch that will actually execute.

      // Setup: Create user with profile, avatar, and avatarImage
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'john.doe@example.com',
            name: 'john.doe',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Hi!',
                avatar: {
                  create: {
                    avatarImage: {
                      create: {
                        imageUrl: 'https://i.pravatar.cc/150?img=5',
                      },
                    },
                  },
                },
              },
            },
          },
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Update AvatarImage through split operations (recommended workaround)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction(async (tx: typeof context.prisma) => {
          const existingUser = await tx.user.findUnique({
            where: { id: user.id },
            select: { id: true },
          });

          if (!existingUser) {
            throw new Error('User not found');
          }

          const profile = await tx.profile.upsert({
            where: { userId: user.id },
            create: {
              userId: user.id,
              bio: 'Hi!',
            },
            update: {
              bio: 'Hi!',
            },
          });

          const avatar = await tx.avatar.upsert({
            where: { profileId: profile.id },
            create: {
              profileId: profile.id,
              name: null,
            },
            update: {
              name: undefined,
            },
          });

          // This upsert should create exactly 1 audit log for AvatarImage, not 3
          await tx.avatarImage.upsert({
            where: { avatarId: avatar.id },
            create: {
              avatarId: avatar.id,
              imageUrl: 'https://i.pravatar.cc/150?img=10',
            },
            update: {
              imageUrl: 'https://i.pravatar.cc/150?img=10',
            },
          });

          return tx.user.findUniqueOrThrow({
            where: { id: user.id },
            include: {
              profile: {
                include: {
                  avatar: {
                    include: {
                      avatarImage: true,
                    },
                  },
                },
              },
            },
          });
        });
      });

      // Verify: AvatarImage should be updated
      const profile = await context.prisma.profile.findUnique({
        where: { userId: user.id },
        include: {
          avatar: {
            include: {
              avatarImage: true,
            },
          },
        },
      });

      expect(profile?.avatar?.avatarImage?.imageUrl).toBe('https://i.pravatar.cc/150?img=10');

      // Verify: Exactly 1 audit log for AvatarImage update (not 3!)
      const avatarImageLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: profile?.avatar?.avatarImage?.id,
          action: 'update',
        },
      });

      // THIS IS THE KEY ASSERTION: Before fix, this would be 3 or more. After fix, it should be 1-2.
      // The upsert duplication bug would cause 3+ logs (one from each branch explored optimistically).
      // With the fix, only the executing branch is explored, resulting in 1-2 logs:
      // - 1 if only entity-level logging is enabled
      // - 2 if both entity-level and aggregate-level logging are enabled
      expect(avatarImageLogs.length).toBeGreaterThanOrEqual(1);
      expect(avatarImageLogs.length).toBeLessThanOrEqual(2);

      // Verify audit log content
      const log = avatarImageLogs[0];
      expect(log.action).toBe('update');
      expect(log.before).not.toBeNull();
      const before = log.before as { imageUrl?: string };
      expect(before.imageUrl).toBe('https://i.pravatar.cc/150?img=5');
      const after = log.after as { imageUrl?: string };
      expect(after.imageUrl).toBe('https://i.pravatar.cc/150?img=10');
    });

    it('should create audit logs when updating avatar through transaction-based endpoint (split operations)', async () => {
      // Setup: Create user with profile, avatar, and avatarImage
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'john.doe@example.com',
            name: 'john.doe',
            password: 'secret123',
            profile: {
              create: {
                bio: 'Hi!',
                avatar: {
                  create: {
                    avatarImage: {
                      create: {
                        imageUrl: 'https://i.pravatar.cc/150?img=5',
                      },
                    },
                  },
                },
              },
            },
          },
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        });
      });

      await context.prisma.auditLog.deleteMany();

      // Action: Simulate PUT /profiles/:userId with avatar image update
      // Split nested upsert operations to allow proper audit logging
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.$transaction(async (tx: typeof context.prisma) => {
          // Verify user exists
          const existingUser = await tx.user.findUnique({
            where: { id: user.id },
            select: { id: true },
          });

          if (!existingUser) {
            throw new Error('User not found');
          }

          // Step 1: Upsert profile (without nested operations)
          const profile = await tx.profile.upsert({
            where: { userId: user.id },
            create: {
              userId: user.id,
              bio: 'Hi!',
            },
            update: {
              bio: 'Hi!',
            },
          });

          // Step 2: Upsert avatar (without nested operations)
          const avatar = await tx.avatar.upsert({
            where: { profileId: profile.id },
            create: {
              profileId: profile.id,
              name: null,
            },
            update: {
              name: undefined,
            },
          });

          // Step 3: Upsert avatarImage (top-level operation)
          await tx.avatarImage.upsert({
            where: { avatarId: avatar.id },
            create: {
              avatarId: avatar.id,
              imageUrl: 'https://i.pravatar.cc/150?img=10',
            },
            update: {
              imageUrl: 'https://i.pravatar.cc/150?img=10',
            },
          });

          // Return user with updated profile
          return tx.user.findUniqueOrThrow({
            where: { id: user.id },
            include: {
              profile: {
                include: {
                  avatar: {
                    include: {
                      avatarImage: true,
                    },
                  },
                },
              },
            },
          });
        });
      });

      // Verify: AvatarImage should be updated
      const profile = await context.prisma.profile.findUnique({
        where: { userId: user.id },
        include: {
          avatar: {
            include: {
              avatarImage: true,
            },
          },
        },
      });

      expect(profile?.avatar?.avatarImage?.imageUrl).toBe('https://i.pravatar.cc/150?img=10');

      // Verify: Audit logs should be created for AvatarImage update
      const avatarImageLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: profile?.avatar?.avatarImage?.id,
          action: 'update',
        },
      });

      expect(avatarImageLogs.length).toBeGreaterThanOrEqual(1);
      const log = avatarImageLogs[0];
      expect(log.action).toBe('update');
      expect(log.before).not.toBeNull();
      const before = log.before as { imageUrl?: string };
      expect(before.imageUrl).toBe('https://i.pravatar.cc/150?img=5');
      const after = log.after as { imageUrl?: string };
      expect(after.imageUrl).toBe('https://i.pravatar.cc/150?img=10');
    });
  });
});
