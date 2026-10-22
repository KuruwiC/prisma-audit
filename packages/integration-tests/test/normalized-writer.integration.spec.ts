/**
 * Integration Tests: Normalized Writer Helpers
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditLogWriter, EntityMap } from '@kuruwic/prisma-audit';
import {
  createAuditClient,
  createEntityNormalizedWriter,
  createSharedChangeWriter,
  defineEntity,
  flushAllPendingWrites,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostReadFault } from './helpers/post-read-fault.js';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testEntities: EntityMap = {
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
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();

  beforeAll(() => {
    basePrisma = createBasePrisma();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await basePrisma.auditEvent.deleteMany();
    await basePrisma.actor.deleteMany();
    await basePrisma.entity.deleteMany();
    await basePrisma.aggregate.deleteMany();

    await basePrisma.auditAggregate.deleteMany();
    await basePrisma.auditChange.deleteMany();

    await cleanDatabase(basePrisma);
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
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        performance: { awaitWrite: false },
        hooks: { writer: createEntityNormalizedWriter(entitySchema) },
      });

      await provider.runAsync(testActor, () =>
        prisma.user.create({ data: { email: 'detached@example.com', name: 'Detached' } }),
      );
      await flushAllPendingWrites();

      expect(await basePrisma.auditEvent.count()).toBe(1);
      expect(await basePrisma.actor.count()).toBe(1);
    });

    it('writes a write queued until the transaction commits, once it has committed', async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        performance: { awaitWrite: false },
        hooks: { writer: createSharedChangeWriter(sharedChangeSchema) },
      });

      await provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'after-commit@example.com', name: 'After Commit' } });
        }),
      );
      await flushAllPendingWrites();

      expect(await basePrisma.auditChange.count()).toBe(1);
      expect(await basePrisma.auditAggregate.count()).toBe(1);
    });

    it("writes an awaited write in the operation's transaction, so a rollback undoes it", async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        performance: { awaitWrite: true },
        hooks: { writer: createEntityNormalizedWriter(entitySchema) },
      });

      const rolledBack = provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'undone@example.com', name: 'Undone' } });
          throw new Error('Rollback test');
        }),
      );

      await expect(rolledBack).rejects.toThrow('Rollback test');
      expect(await basePrisma.auditEvent.count()).toBe(0);
      expect(await basePrisma.actor.count()).toBe(0);
    });

    it("writes an awaited shared-change write in the operation's transaction, so a rollback undoes it", async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        performance: { awaitWrite: true },
        hooks: { writer: createSharedChangeWriter(sharedChangeSchema) },
      });

      const rolledBack = provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'undone@example.com', name: 'Undone' } });
          throw new Error('Rollback test');
        }),
      );

      await expect(rolledBack).rejects.toThrow('Rollback test');
      expect(await basePrisma.auditChange.count()).toBe(0);
      expect(await basePrisma.auditAggregate.count()).toBe(0);
    });
  });

  describe('Pattern 1: Entity Normalization (createEntityNormalizedWriter)', () => {
    it('should write audit logs to normalized schema (Actor, Entity, Aggregate, AuditEvent)', async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
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

      await provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: {
            email: 'alice@example.com',
            name: 'Alice',
          },
        });
      });

      const actors = await basePrisma.actor.findMany();
      const entities = await basePrisma.entity.findMany();
      const aggregates = await basePrisma.aggregate.findMany();
      const events = await basePrisma.auditEvent.findMany({
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

    it('should deduplicate the actor, entity and aggregate rows of two writes to the same entity', async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
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

      await provider.runAsync(testActor, async () => {
        const user = await prisma.user.create({
          data: { email: 'user1@example.com', name: 'User 1' },
        });
        await prisma.user.update({
          where: { id: user.id },
          data: { name: 'User 1 renamed' },
        });
      });

      const actors = await basePrisma.actor.findMany();
      const entities = await basePrisma.entity.findMany();
      const aggregates = await basePrisma.aggregate.findMany();
      const events = await basePrisma.auditEvent.findMany();

      expect(actors).toHaveLength(1);
      expect(entities).toHaveLength(1);
      expect(aggregates).toHaveLength(1);
      expect(events.map((event) => event.action).sort()).toEqual(['create', 'update']);
      expect(new Set(events.map((event) => event.entityId))).toEqual(new Set([entities[0]?.id]));
      expect(new Set(events.map((event) => event.aggregateId))).toEqual(new Set([aggregates[0]?.id]));
    });

    it('should accept lowerCamelCase model names', async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
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

      await provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: { email: 'test@example.com', name: 'Test' },
        });
      });

      const events = await basePrisma.auditEvent.findMany();
      expect(events).toHaveLength(1);
    });
  });

  describe('Pattern 2: Shared Change Normalization (createSharedChangeWriter)', () => {
    it('should write audit logs to shared change schema (AuditChange, AuditAggregate)', async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
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

      await provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: {
            email: 'alice@example.com',
            name: 'Alice',
          },
        });
      });

      const changes = await basePrisma.auditChange.findMany();
      const aggregates = await basePrisma.auditAggregate.findMany({
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
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
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

      const user = await provider.runAsync(testActor, async () => {
        return await prisma.user.create({
          data: { email: 'alice@example.com', name: 'Alice' },
        });
      });

      const post = await provider.runAsync(testActor, async () => {
        return await prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      await basePrisma.auditAggregate.deleteMany();
      await basePrisma.auditChange.deleteMany();

      await provider.runAsync(testActor, async () => {
        await prisma.comment.create({
          data: {
            content: 'Hello!',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      const changes = await basePrisma.auditChange.findMany();
      const aggregates = await basePrisma.auditAggregate.findMany();

      expect(changes).toHaveLength(1);
      expect(aggregates).toHaveLength(3);

      for (const aggregate of aggregates) {
        expect(aggregate.changeId).toBe(changes[0]?.id);
      }

      const aggregateTypes = aggregates.map((a: { aggregateType: string }) => a.aggregateType).sort();
      expect(aggregateTypes).toEqual(['Comment', 'Post', 'User']);
    });

    it('should accept lowerCamelCase model names', async () => {
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
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

      await provider.runAsync(testActor, async () => {
        await prisma.user.create({
          data: { email: 'test@example.com', name: 'Test' },
        });
      });

      const changes = await basePrisma.auditChange.findMany();
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
      const { findUnique, armFindUniqueFailure } = createPostReadFault('simulated before-state read failure');
      const faulty = basePrisma.$extends({ name: 'fault-injection', query: { post: { findUnique } } });
      const prisma = createAuditClient(faulty, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        performance: { awaitWrite: true },
        hooks: { writer },
      });
      return { prisma, armFindUniqueFailure };
    };

    const updatePostAfterFailedBeforeRead = async (writer: AuditLogWriter) => {
      const { prisma, armFindUniqueFailure } = createClientFailingBeforeRead(writer);
      const user = await basePrisma.user.create({ data: { email: 'author@example.com', name: 'Author' } });
      const post = await provider.runAsync(testActor, () =>
        prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
      );
      armFindUniqueFailure();
      await provider.runAsync(testActor, () =>
        prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
      );
    };

    /** One row per aggregate the post belongs to (the post and its author), as `[action, beforeUnavailable, aggregate type]` */
    const eventsOfPost = async () =>
      (await basePrisma.auditEvent.findMany({ include: { aggregate: true } }))
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

      const changes = await basePrisma.auditChange.findMany({
        where: { entityType: 'Post' },
        orderBy: { action: 'asc' },
      });
      expect(changes.map((change) => [change.action, change.beforeUnavailable])).toEqual([
        ['create', false],
        ['update', true],
      ]);
    });

    it('is not stored by the shared-change writer when the schema names no field for it', async () => {
      await updatePostAfterFailedBeforeRead(createSharedChangeWriter(sharedChangeSchema));

      const changes = await basePrisma.auditChange.findMany({ where: { action: 'update' } });
      expect(changes.map((change) => [change.action, change.beforeUnavailable])).toEqual([['update', false]]);
    });
  });
});
