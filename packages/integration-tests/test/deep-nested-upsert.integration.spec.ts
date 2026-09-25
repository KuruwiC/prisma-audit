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
    // 1. Pre-fetch captures the deeply nested records before the write (before state)
    // 2. The written relations are added to the operation's selection, so its result returns
    //    the deeply nested records as written (after state)
    // 3. Audit logs are created with correct before/after states
    it('should create audit logs when updating avatar image through profile.upsert', async () => {
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
      expect(before.imageUrl).toBe('https://example.com/original.png');
      const after = log.after as { imageUrl?: string };
      expect(after.imageUrl).toBe('https://example.com/updated.png');
    });

    // The create path needs no pre-fetch: a created record's `before` is null.
    it('should create audit logs when creating avatar image through profile.upsert (create path)', async () => {
      // No avatarImage yet, so the nested upsert takes its create path
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

    it('should create audit logs when updating avatar through transaction-based endpoint (split operations)', async () => {
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
