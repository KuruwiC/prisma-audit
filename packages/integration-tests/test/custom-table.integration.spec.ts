import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

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

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const { execSync } = await import('node:child_process');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const Filename = fileURLToPath(import.meta.url);
    const Dirname = dirname(Filename);

    console.log('Starting PostgreSQL container for custom table tests...');
    const container = await new PostgreSqlContainer('postgres:16-alpine').withExposedPorts(5432).start();

    const databaseUrl = container.getConnectionUri();
    console.log('PostgreSQL container started');

    const databasePackagePath = join(Dirname, '../../database');
    const schemaPath = join(databasePackagePath, 'prisma/schema.prisma');

    execSync(`npx prisma db push --schema=${schemaPath} --skip-generate`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const basePrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });

    const provider = createAsyncLocalStorageProvider();

    const prisma = createAuditClient(basePrisma, {
      DbNull: Prisma.DbNull,
      provider,
      basePrisma,
      aggregateMapping: testAggregateMapping,
      performance: {
        awaitWrite: true,
      },
    });

    const customBasePrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    const customPrisma = createAuditClient(customBasePrisma, {
      provider,
      basePrisma: customBasePrisma,
      DbNull: Prisma.DbNull,
      aggregateMapping: testAggregateMapping,
      auditLogModel: 'Activity',
      performance: {
        awaitWrite: true,
      },
      hooks: {
        errorHandler: (error, operation) => {
          console.error(`[Custom Table Test] Audit error in ${operation}:`, error);
          throw error;
        },
      },
    });

    context = {
      container,
      prisma,
      basePrisma,
      provider,
      databaseUrl,
    };

    customContext = {
      ...context,
      customPrisma,
    };

    console.log('Custom table test database setup complete');
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
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

      // Verify: audit log was written to activities table
      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities).toHaveLength(1);
      expect(activities[0].entityType).toBe('User');
      expect(activities[0].action).toBe('create');
      expect(activities[0].actorId).toBe('test-user-1');

      // Verify: default auditLog table should be empty
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

      // Clean activities after setup
      await customContext.customPrisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');

      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated User' },
        });
      });

      // Verify: update audit log was written to activities table
      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities).toHaveLength(1);
      expect(activities[0].entityType).toBe('User');
      expect(activities[0].action).toBe('update');
      expect(activities[0].changes).toBeDefined();
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

      // Clean activities after setup
      await customContext.customPrisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');

      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.delete({
          where: { id: user.id },
        });
      });

      // Verify: delete audit log was written to activities table
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

      // Verify: all audit logs were written to activities table
      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities.length).toBeGreaterThan(2); // User + Posts + aggregates

      const userLogs = activities.filter((log: { entityType: string }) => log.entityType === 'User');
      const postLogs = activities.filter((log: { entityType: string }) => log.entityType === 'Post');

      expect(userLogs.length).toBeGreaterThan(0);
      expect(postLogs.length).toBeGreaterThan(0);
    });

    it('should handle batch operations with custom table', async () => {
      // Create users for updateMany
      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1', password: 'secret123' },
            { email: 'user2@example.com', name: 'User 2', password: 'secret123' },
            { email: 'user3@example.com', name: 'User 3', password: 'secret123' },
          ],
        });
      });

      // Clean activities after setup
      await customContext.customPrisma.$executeRawUnsafe('TRUNCATE TABLE activities CASCADE');

      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.updateMany({
          where: { email: { contains: 'example.com' } },
          data: { name: 'Updated' },
        });
      });

      // Verify: updateMany audit logs were written to activities table
      const activities = await customContext.customPrisma.activity.findMany();
      expect(activities.length).toBeGreaterThanOrEqual(3); // 3 users updated

      for (const activity of activities) {
        expect(activity.action).toBe('update');
        expect(activity.entityType).toBe('User');
      }
    });
  });

  describe('Table isolation', () => {
    it('should maintain separate audit logs for different clients', async () => {
      // Write to default auditLog table
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.create({
          data: {
            email: 'default@example.com',
            name: 'Default User',
            password: 'secret123',
          },
        });
      });

      // Write to custom activities table
      await customContext.provider.runAsync(testActor, async () => {
        await customContext.customPrisma.user.create({
          data: {
            email: 'custom@example.com',
            name: 'Custom User',
            password: 'secret123',
          },
        });
      });

      // Verify: each table has its own audit log
      const auditLogs = await context.prisma.auditLog.findMany();
      const activities = await customContext.customPrisma.activity.findMany();

      expect(auditLogs).toHaveLength(1);
      expect(activities).toHaveLength(1);

      // Verify: logs are in the correct tables
      expect(auditLogs[0].entityType).toBe('User');
      expect(activities[0].entityType).toBe('User');
    });
  });
});
