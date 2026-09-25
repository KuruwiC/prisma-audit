import type { AuditContext } from '@kuruwic/db-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createTestContext, disposeTestContext, type TestContext } from './helpers/setup.js';

describe('Deep Nested Upsert Operations (Profile → Avatar → AvatarImage)', () => {
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

  describe('Avatar Update via Nested Upsert (3 levels deep)', () => {
    // 3-level nested operations (Profile → Avatar → AvatarImage):
    // 1. Pre-fetch captures IDs from deeply nested records (before state)
    // 2. The operation result does not include deeply nested records, so `refetchNestedRecords`
    //    uses those IDs to retrieve the current state (after state)
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

      // Verify: Audit logs should be created for AvatarImage update
      const avatarImageLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: profile?.avatar?.avatarImage?.id,
          action: 'update',
        },
      });

      // One log per aggregate root: AvatarImage self-projects (aggregateType: 'AvatarImage') and
      // projects onto its Avatar aggregate (aggregateType: 'Avatar', via `to('Avatar', foreignKey('avatarId'))`).
      expect(avatarImageLogs).toHaveLength(2);

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

      // One log per aggregate root: AvatarImage self-projects (aggregateType: 'AvatarImage') and
      // projects onto its Avatar aggregate (aggregateType: 'Avatar', via `to('Avatar', foreignKey('avatarId'))`).
      expect(avatarImageLogs).toHaveLength(2);
      const log = avatarImageLogs[0];
      expect(log.action).toBe('create');
      expect(log.before).toBeNull(); // Create always has null 'before'
      const after = log.after as { imageUrl?: string };
      expect(after.imageUrl).toBe('https://example.com/new.png');
    });
  });

  describe('PUT /profiles/:userId endpoint simulation (Transaction)', () => {
    it('should not duplicate AvatarImage update logs when each level is upserted separately in a transaction', async () => {
      // Profile, Avatar, and AvatarImage are written as separate top-level upserts in one
      // transaction; each upsert is audited only for the branch its before-state fetch identifies.

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

      // Verify: Audit logs should be created for AvatarImage update
      const avatarImageLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: profile?.avatar?.avatarImage?.id,
          action: 'update',
        },
      });

      // One log per aggregate root: AvatarImage self-projects (aggregateType: 'AvatarImage') and
      // projects onto its Avatar aggregate (aggregateType: 'Avatar', via `to('Avatar', foreignKey('avatarId'))`).
      expect(avatarImageLogs).toHaveLength(2);

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

      // One log per aggregate root: AvatarImage self-projects (aggregateType: 'AvatarImage') and
      // projects onto its Avatar aggregate (aggregateType: 'Avatar', via `to('Avatar', foreignKey('avatarId'))`).
      expect(avatarImageLogs).toHaveLength(2);
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
