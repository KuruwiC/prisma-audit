/**
 * Integration Tests: Normalized Writer Helpers
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping, AuditLogWriter } from '@kuruwic/prisma-audit';
import {
  createAuditClient,
  createEntityNormalizedWriter,
  createSharedChangeWriter,
  defineEntity,
  flushAllPendingWrites,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase, disposeTestContext, type TestContext } from './helpers/setup.js';

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
    const databaseUrl = inject('databaseUrl');

    const basePrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });

    const provider = createAsyncLocalStorageProvider();

    context = {
      prisma: basePrisma as never,
      basePrisma,
      provider,
      databaseUrl,
    };
  });

  afterAll(async () => {
    await disposeTestContext(context);
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

  describe('the handle the helpers write on', () => {
    const entitySchema = {
      actorModel: 'Actor',
      entityModel: 'Entity',
      aggregateModel: 'Aggregate',
      eventModel: 'AuditEvent',
    };
    const sharedChangeSchema = { changeModel: 'AuditChange', aggregateModel: 'AuditAggregate' };

    it('writes a detached write in a transaction of its own on the base client', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
        hooks: { writer: createEntityNormalizedWriter(entitySchema) },
      });

      await context.provider.runAsync(testActor, () =>
        prisma.user.create({ data: { email: 'detached@example.com', name: 'Detached' } }),
      );
      await flushAllPendingWrites();

      expect(await context.basePrisma.auditEvent.count()).toBe(1);
      expect(await context.basePrisma.actor.count()).toBe(1);
    });

    it('writes a write queued until the transaction commits, once it has committed', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
        hooks: { writer: createSharedChangeWriter(sharedChangeSchema) },
      });

      await context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'after-commit@example.com', name: 'After Commit' } });
        }),
      );
      await flushAllPendingWrites();

      expect(await context.basePrisma.auditChange.count()).toBe(1);
      expect(await context.basePrisma.auditAggregate.count()).toBe(1);
    });

    it("writes an awaited write in the operation's transaction, so a rollback undoes it", async () => {
      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        hooks: { writer: createEntityNormalizedWriter(entitySchema) },
      });

      const rolledBack = context.provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'undone@example.com', name: 'Undone' } });
          throw new Error('Rollback test');
        }),
      );

      await expect(rolledBack).rejects.toThrow('Rollback test');
      expect(await context.basePrisma.auditEvent.count()).toBe(0);
      expect(await context.basePrisma.actor.count()).toBe(0);
    });
  });

  describe('Pattern 1: Entity Normalization (createEntityNormalizedWriter)', () => {
    it('should write audit logs to normalized schema (Actor, Entity, Aggregate, AuditEvent)', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createEntityNormalizedWriter({
            actorModel: 'Actor',
            entityModel: 'Entity',
            aggregateModel: 'Aggregate',
            eventModel: 'AuditEvent',
          }),
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
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createEntityNormalizedWriter({
            actorModel: 'Actor',
            entityModel: 'Entity',
            aggregateModel: 'Aggregate',
            eventModel: 'AuditEvent',
          }),
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
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createEntityNormalizedWriter({
            actorModel: 'actor',
            entityModel: 'entity',
            aggregateModel: 'aggregate',
            eventModel: 'auditEvent',
          }),
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
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createSharedChangeWriter({
            changeModel: 'AuditChange',
            aggregateModel: 'AuditAggregate',
          }),
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
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createSharedChangeWriter({
            changeModel: 'AuditChange',
            aggregateModel: 'AuditAggregate',
          }),
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
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: {
          awaitWrite: true,
        },
        hooks: {
          writer: createSharedChangeWriter({
            changeModel: 'auditChange',
            aggregateModel: 'auditAggregate',
          }),
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

  describe('the beforeUnavailable marker', () => {
    const entitySchema = {
      actorModel: 'Actor',
      entityModel: 'Entity',
      aggregateModel: 'Aggregate',
      eventModel: 'AuditEvent',
    };
    const sharedChangeSchema = { changeModel: 'AuditChange', aggregateModel: 'AuditAggregate' };

    /** An audited client whose before-state read of a Post update is failed once it is armed */
    const createClientFailingBeforeRead = (writer: AuditLogWriter) => {
      let failNextFindUnique = false;
      const basePrisma = context.basePrisma.$extends({
        name: 'fault-injection',
        query: {
          post: {
            async findUnique({ args, query }) {
              if (failNextFindUnique) {
                failNextFindUnique = false;
                throw new Error('simulated before-state read failure');
              }
              return query(args);
            },
          },
        },
      });
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        hooks: { writer },
      });
      return {
        prisma,
        armFindUniqueFailure: () => {
          failNextFindUnique = true;
        },
      };
    };

    const updatePostAfterFailedBeforeRead = async (writer: AuditLogWriter) => {
      const { prisma, armFindUniqueFailure } = createClientFailingBeforeRead(writer);
      const user = await context.basePrisma.user.create({ data: { email: 'author@example.com', name: 'Author' } });
      const post = await context.provider.runAsync(testActor, () =>
        prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
      );
      armFindUniqueFailure();
      await context.provider.runAsync(testActor, () =>
        prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
      );
    };

    /** One row per aggregate the post belongs to (the post and its author), as `[action, beforeUnavailable, aggregate type]` */
    const eventsOfPost = async () =>
      (await context.basePrisma.auditEvent.findMany({ include: { aggregate: true } }))
        .map((event) => [event.action, event.beforeUnavailable, event.aggregate.type] as const)
        .sort();

    it('is stored by the entity-normalized writer in the event field the schema names', async () => {
      await updatePostAfterFailedBeforeRead(
        createEntityNormalizedWriter({ ...entitySchema, beforeUnavailableField: 'beforeUnavailable' }),
      );

      expect(await eventsOfPost()).toEqual([
        ['create', false, 'Post'],
        ['create', false, 'User'],
        ['update', true, 'Post'],
        ['update', true, 'User'],
      ]);
    });

    it('is not stored by the entity-normalized writer when the schema names no field for it', async () => {
      await updatePostAfterFailedBeforeRead(createEntityNormalizedWriter(entitySchema));

      expect(await eventsOfPost()).toEqual([
        ['create', false, 'Post'],
        ['create', false, 'User'],
        ['update', false, 'Post'],
        ['update', false, 'User'],
      ]);
    });

    it('is stored by the shared-change writer in the change field the schema names', async () => {
      await updatePostAfterFailedBeforeRead(
        createSharedChangeWriter({ ...sharedChangeSchema, beforeUnavailableField: 'beforeUnavailable' }),
      );

      const changes = await context.basePrisma.auditChange.findMany({
        where: { entityType: 'Post' },
        orderBy: { createdAt: 'asc' },
      });
      expect(changes.map((change) => [change.action, change.beforeUnavailable])).toEqual([
        ['create', false],
        ['update', true],
      ]);
    });

    it('is not stored by the shared-change writer when the schema names no field for it', async () => {
      await updatePostAfterFailedBeforeRead(createSharedChangeWriter(sharedChangeSchema));

      const changes = await context.basePrisma.auditChange.findMany({ where: { action: 'update' } });
      expect(changes.map((change) => [change.action, change.beforeUnavailable])).toEqual([['update', false]]);
    });
  });
});
