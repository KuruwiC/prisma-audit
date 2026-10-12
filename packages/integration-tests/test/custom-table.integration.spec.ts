import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase, createBasePrisma, disposeTestContext, type TestContext } from './helpers/setup.js';

const testAggregateMapping: AggregateMapping = {
  User: defineEntity({
    type: 'User',
    excludeFields: ['updatedAt'],
  }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
};

describe('Custom Audit Log Table', () => {
  let context: TestContext;
  let customContext: TestContext & { customPrisma: ReturnType<typeof createAuditClient> };
  let customBasePrisma: PrismaClient;

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');

    const basePrisma = createBasePrisma(databaseUrl);

    const provider = createAsyncLocalStorageProvider();

    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: testAggregateMapping,
      performance: {
        awaitWrite: true,
      },
    });

    customBasePrisma = createBasePrisma(databaseUrl);
    const customPrisma = createAuditClient(customBasePrisma, {
      provider,
      Prisma,
      schema: auditSchema,
      aggregateMapping: testAggregateMapping,
      auditLogModel: 'Activity',
      performance: {
        awaitWrite: true,
      },
      errorHandling: {
        writeFailurePolicy: (context) => {
          console.error(`[Custom Table Test] Audit error in ${context.phase}:`, context.error);
          return 'throw';
        },
      },
    });

    context = {
      prisma,
      basePrisma,
      provider,
      databaseUrl,
    };

    customContext = {
      ...context,
      customPrisma,
    };
  });

  afterAll(async () => {
    await disposeTestContext({ ...context, prisma: customContext.customPrisma, basePrisma: customBasePrisma });
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
    await context.prisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Default auditLog table', () => {
    it('should write to auditLog table by default', async () => {
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const auditLogs = await context.prisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].entityType).toBe('User');
      expect(auditLogs[0].action).toBe('create');

      const activities = await context.prisma.activity.findMany();
      expect(activities).toHaveLength(0);
    });
  });

  describe('Custom activities table', () => {
    it('should write to activities table when auditLogModel is set', async () => {
      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities).toHaveLength(1);
      expect(activities[0].entityType).toBe('User');
      expect(activities[0].action).toBe('create');
      expect(activities[0].actorId).toBe('test-user-1');

      const auditLogs = await customContext.customPrisma.auditLog.findMany();
      expect(auditLogs).toHaveLength(0);
    });

    it('should handle update operations with custom table', async () => {
      const user = await customContext.provider.runAsync(testActor, async () => {
        return await customContext.customPrisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Drop the setup create's log so only the operation under test is counted
      await customContext.customPrisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');

      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated User' },
        });
      });

      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities).toHaveLength(1);
      expect(activities[0].entityType).toBe('User');
      expect(activities[0].action).toBe('update');
      expect(activities[0].changes).toEqual({ name: { old: 'User', new: 'Updated User' } });
    });

    it('should handle delete operations with custom table', async () => {
      const user = await customContext.provider.runAsync(testActor, async () => {
        return await customContext.customPrisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Drop the setup create's log so only the operation under test is counted
      await customContext.customPrisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');

      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.delete({
          where: { id: user.id },
        });
      });

      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities).toHaveLength(1);
      expect(activities[0].entityType).toBe('User');
      expect(activities[0].action).toBe('delete');
    });

    it('should handle nested operations with custom table', async () => {
      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            posts: {
              create: [
                { title: 'Post 1', content: 'Content 1' },
                { title: 'Post 2', content: 'Content 2' },
              ],
            },
          },
          include: { posts: true },
        });
      });

      const activities = await customContext.customPrisma.activity.findMany();
      // The User log, plus each of the 2 Posts under both its own aggregate and the User aggregate
      expect(activities).toHaveLength(5);

      const userLogs = activities.filter((log: { entityType: string }) => log.entityType === 'User');
      const postLogs = activities.filter((log: { entityType: string }) => log.entityType === 'Post');

      expect(userLogs).toHaveLength(1);
      expect(postLogs).toHaveLength(4);
    });

    it('should handle batch operations with custom table', async () => {
      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1', password: 'secret123' },
            { email: 'user2@example.com', name: 'User 2', password: 'secret123' },
            { email: 'user3@example.com', name: 'User 3', password: 'secret123' },
          ],
        });
      });

      // Drop the setup create's log so only the operation under test is counted
      await customContext.customPrisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');

      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.updateMany({
          where: { email: { contains: 'example.com' } },
          data: { name: 'Updated' },
        });
      });

      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities).toHaveLength(3); // 3 users updated

      for (const activity of activities) {
        expect(activity.action).toBe('update');
        expect(activity.entityType).toBe('User');
      }
    });
  });
});
