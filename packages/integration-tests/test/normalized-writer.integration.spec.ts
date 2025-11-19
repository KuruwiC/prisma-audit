/**
 * Integration Tests: Normalized Writer Helpers
 */

import type { AggregateMapping } from '@kuruwic/prisma-audit';
import {
  createAuditClient,
  createEntityNormalizedWriter,
  createSharedChangeWriter,
  defineEntity,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
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
  Comment: defineEntity({
    type: 'Comment',
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
  }),
};

describe('Normalized Writer Helpers', () => {
  let context: TestContext;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const { execSync } = await import('node:child_process');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const Filename = fileURLToPath(import.meta.url);
    const Dirname = dirname(Filename);

    console.log('Starting PostgreSQL container for normalized writer tests...');
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

    context = {
      container,
      prisma: basePrisma as never,
      basePrisma,
      provider,
      databaseUrl,
    };

    console.log('Normalized writer test database setup complete');
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await context.basePrisma.auditEvent.deleteMany();
    await context.basePrisma.actor.deleteMany();
    await context.basePrisma.entity.deleteMany();
    await context.basePrisma.aggregate.deleteMany();

    await context.basePrisma.auditAggregate.deleteMany();
    await context.basePrisma.auditChange.deleteMany();

    await cleanDatabase(context.basePrisma);
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Pattern 1: Entity Normalization (createEntityNormalizedWriter)', () => {
    it('should write audit logs to normalized schema (Actor, Entity, Aggregate, AuditEvent)', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider: context.provider,
        basePrisma: context.basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createEntityNormalizedWriter(
            {
              actorModel: 'Actor',
              entityModel: 'Entity',
              aggregateModel: 'Aggregate',
              eventModel: 'AuditEvent',
            },
            context.basePrisma,
          ),
        },
      });

      await context.provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: {
            email: 'alice@example.com',
            name: 'Alice',
          },
        });
      });

      const actors = await context.basePrisma.actor.findMany();
      const entities = await context.basePrisma.entity.findMany();
      const aggregates = await context.basePrisma.aggregate.findMany();
      const events = await context.basePrisma.auditEvent.findMany({
        include: { actor: true, entity: true, aggregate: true },
      });

      expect(actors).toHaveLength(1);
      expect(entities).toHaveLength(1);
      expect(aggregates).toHaveLength(1);
      expect(events).toHaveLength(1);

      expect(actors[0]).toMatchObject({
        category: testActor.actor.category,
        type: testActor.actor.type,
        externalId: testActor.actor.id,
      });

      expect(entities[0]).toMatchObject({
        category: 'model',
        type: 'User',
      });

      expect(aggregates[0]).toMatchObject({
        category: 'model',
        type: 'User',
      });

      expect(events[0]?.actorId).toBe(actors[0]?.id);
      expect(events[0]?.entityId).toBe(entities[0]?.id);
      expect(events[0]?.aggregateId).toBe(aggregates[0]?.id);
      expect(events[0]?.action).toBe('create');
    });

    it('should deduplicate actors/entities/aggregates across multiple operations', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider: context.provider,
        basePrisma: context.basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createEntityNormalizedWriter(
            {
              actorModel: 'Actor',
              entityModel: 'Entity',
              aggregateModel: 'Aggregate',
              eventModel: 'AuditEvent',
            },
            context.basePrisma,
          ),
        },
      });

      await context.provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: { email: 'user1@example.com', name: 'User 1' },
        });
        await prisma.user.create({
          data: { email: 'user2@example.com', name: 'User 2' },
        });
        await prisma.user.create({
          data: { email: 'user3@example.com', name: 'User 3' },
        });
      });

      const actors = await context.basePrisma.actor.findMany();
      const entities = await context.basePrisma.entity.findMany();
      const events = await context.basePrisma.auditEvent.findMany();

      expect(actors).toHaveLength(1);
      expect(entities).toHaveLength(3);
      expect(events).toHaveLength(3);
    });

    it('should support both lowerCamelCase and UpperCamelCase model names', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider: context.provider,
        basePrisma: context.basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createEntityNormalizedWriter(
            {
              actorModel: 'actor',
              entityModel: 'entity',
              aggregateModel: 'aggregate',
              eventModel: 'auditEvent',
            },
            context.basePrisma,
          ),
        },
      });

      await context.provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: { email: 'test@example.com', name: 'Test' },
        });
      });

      const events = await context.basePrisma.auditEvent.findMany();
      expect(events).toHaveLength(1);
    });
  });

  describe('Pattern 2: Shared Change Normalization (createSharedChangeWriter)', () => {
    it('should write audit logs to shared change schema (AuditChange, AuditAggregate)', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider: context.provider,
        basePrisma: context.basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createSharedChangeWriter(
            {
              changeModel: 'AuditChange',
              aggregateModel: 'AuditAggregate',
            },
            context.basePrisma,
          ),
        },
      });

      await context.provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: {
            email: 'alice@example.com',
            name: 'Alice',
          },
        });
      });

      const changes = await context.basePrisma.auditChange.findMany();
      const aggregates = await context.basePrisma.auditAggregate.findMany({
        include: { change: true },
      });

      expect(changes).toHaveLength(1);
      expect(aggregates).toHaveLength(1);

      expect(changes[0]).toMatchObject({
        entityCategory: 'model',
        entityType: 'User',
        action: 'create',
      });

      expect(aggregates[0]).toMatchObject({
        changeId: changes[0]?.id,
        actorCategory: testActor.actor.category,
        actorType: testActor.actor.type,
        actorId: testActor.actor.id,
        aggregateCategory: 'model',
        aggregateType: 'User',
      });
    });

    it('should deduplicate change data when entity belongs to multiple aggregates', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider: context.provider,
        basePrisma: context.basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createSharedChangeWriter(
            {
              changeModel: 'AuditChange',
              aggregateModel: 'AuditAggregate',
            },
            context.basePrisma,
          ),
        },
      });

      const user = await context.provider.runAsync(testActor, async () => {
        return await prisma.user.create({
          data: { email: 'alice@example.com', name: 'Alice' },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      await context.basePrisma.auditAggregate.deleteMany();
      await context.basePrisma.auditChange.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await prisma.comment.create({
          data: {
            content: 'Hello!',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      const changes = await context.basePrisma.auditChange.findMany();
      const aggregates = await context.basePrisma.auditAggregate.findMany();

      expect(changes).toHaveLength(1);
      expect(aggregates).toHaveLength(3);

      for (const aggregate of aggregates) {
        expect(aggregate.changeId).toBe(changes[0]?.id);
      }

      const aggregateTypes = aggregates.map((a: { aggregateType: string }) => a.aggregateType).sort();
      expect(aggregateTypes).toEqual(['Comment', 'Post', 'User']);
    });

    it('should support both lowerCamelCase and UpperCamelCase model names', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider: context.provider,
        basePrisma: context.basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createSharedChangeWriter(
            {
              changeModel: 'auditChange',
              aggregateModel: 'auditAggregate',
            },
            context.basePrisma,
          ),
        },
      });

      await context.provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: { email: 'test@example.com', name: 'Test' },
        });
      });

      const changes = await context.basePrisma.auditChange.findMany();
      expect(changes).toHaveLength(1);
    });
  });
});
