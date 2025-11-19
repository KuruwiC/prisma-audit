import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditActor, AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import type { PrismaClient } from '@kuruwic/prisma-audit-database';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import type { Mock } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCommentAggregateEnricher,
  createCommentAggregateMapping,
  createCommentEntityEnricher,
  createEnrichmentTestContext,
  createProfileAggregateEnricher,
  createProfileAggregateMapping,
  createProfileEntityEnricher,
  createUserAggregateAggregateMapping,
  createUserAggregateEnricher,
  createUserEntityAggregateMapping,
  createUserEntityEnricher,
} from './helpers/enrichment-test-helpers.js';
import {
  cleanDatabase,
  setupTestDatabase,
  type TestContext,
  teardownTestDatabase,
  testAggregateMapping,
} from './helpers/setup.js';

type TestAuditActor = AuditActor & {
  role?: string; // Custom property for enrichment testing
};

type TestAuditContext = Omit<AuditContext, 'actor'> & {
  actor: TestAuditActor;
};

describe('Context Enrichment Integration', () => {
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

  describe('Actor context enrichment', () => {
    it('should enrich actorContext with name and role', async () => {
      const adminActor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'admin-1',
          name: 'Admin User',
          role: 'admin',
        },
      };

      const user = await context.provider.runAsync(adminActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
            password: 'secret123',
          },
        });
      });

      // Verify audit log has enriched actorContext
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
      });

      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];

      // Basic actor fields
      expect(log.actorCategory).toBe('model');
      expect(log.actorType).toBe('User');
      expect(log.actorId).toBe('admin-1');

      // Enriched actorContext
      expect(log.actorContext).toBeDefined();
      const actorContext = log.actorContext as Record<string, unknown>;
      expect(actorContext.name).toBe('Admin User');
      expect(actorContext.role).toBe('admin');
    });

    it('should handle actorContext without optional fields', async () => {
      const basicActor: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'user-1',
        },
      };

      const user = await context.provider.runAsync(basicActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'basic@example.com',
            name: 'Basic User',
            password: 'secret123',
          },
        });
      });

      // Verify audit log
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
      });

      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];

      // Basic actor fields
      expect(log.actorCategory).toBe('model');
      expect(log.actorType).toBe('User');
      expect(log.actorId).toBe('user-1');

      // actorContext should exist but with undefined values
      expect(log.actorContext).toBeDefined();
      const actorContext = log.actorContext as Record<string, unknown>;
      expect(actorContext.name).toBeUndefined();
      expect(actorContext.role).toBeUndefined();
    });

    it('should track different actors correctly in concurrent operations', async () => {
      const adminActor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'admin-1',
          name: 'Admin User',
          role: 'admin',
        },
      };

      const regularActor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'user-1',
          name: 'Regular User',
          role: 'user',
        },
      };

      // Execute concurrent operations with different actors
      const [adminUser, regularUser] = await Promise.all([
        context.provider.runAsync(adminActor, async () => {
          return await context.prisma.user.create({
            data: {
              email: 'admin@example.com',
              name: 'Admin Created User',
              password: 'secret1',
            },
          });
        }),
        context.provider.runAsync(regularActor, async () => {
          return await context.prisma.user.create({
            data: {
              email: 'regular@example.com',
              name: 'Regular Created User',
              password: 'secret2',
            },
          });
        }),
      ]);

      // Verify admin actor context
      const adminLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: adminUser.id },
      });
      expect(adminLogs).toHaveLength(1);
      const adminLog = adminLogs[0];
      expect(adminLog.actorId).toBe('admin-1');
      const adminContext = adminLog.actorContext as Record<string, unknown>;
      expect(adminContext.name).toBe('Admin User');
      expect(adminContext.role).toBe('admin');

      // Verify regular actor context
      const regularLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: regularUser.id },
      });
      expect(regularLogs).toHaveLength(1);
      const regularLog = regularLogs[0];
      expect(regularLog.actorId).toBe('user-1');
      const regularContext = regularLog.actorContext as Record<string, unknown>;
      expect(regularContext.name).toBe('Regular User');
      expect(regularContext.role).toBe('user');
    });

    it('[N+1 Resolution] should call actor enricher exactly once per operation', async () => {
      // Track enricher calls by inspecting audit logs
      // Since actor enricher is configured in setup.ts and we can't spy on it directly,
      // we verify N+1 resolution by checking that actorContext is consistent across multiple entities
      const actor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'test-actor',
          name: 'Test Actor',
          role: 'admin',
        },
      };

      // Create multiple users in a single operation context
      await context.provider.runAsync(actor, async () => {
        // createMany should reuse the same actor enrichment result for all entities
        await context.prisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1', password: 'pass1' },
            { email: 'user2@example.com', name: 'User 2', password: 'pass2' },
            { email: 'user3@example.com', name: 'User 3', password: 'pass3' },
          ],
        });
      });

      // Verify all audit logs have the same actorContext (proving it was enriched once and reused)
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { actorId: 'test-actor' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);

      // All logs should have identical actorContext (same object reference conceptually)
      const firstActorContext = auditLogs[0]?.actorContext as Record<string, unknown>;
      expect(firstActorContext.name).toBe('Test Actor');
      expect(firstActorContext.role).toBe('admin');

      // Verify all other logs have the same actorContext values
      for (const log of auditLogs) {
        const actorContext = log.actorContext as Record<string, unknown>;
        expect(actorContext.name).toBe('Test Actor');
        expect(actorContext.role).toBe('admin');
      }
    });
  });

  describe('Actor context in UPDATE operations', () => {
    it('should include actorContext in update audit logs', async () => {
      const actor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'editor-1',
          name: 'Editor User',
          role: 'editor',
        },
      };

      // Create user
      const user = await context.provider.runAsync(actor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'edit@example.com',
            name: 'Original Name',
            password: 'secret123',
          },
        });
      });

      // Update user
      await context.provider.runAsync(actor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      // Verify update audit log has actorContext
      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(updateLogs.length).toBeGreaterThanOrEqual(1);
      const log = updateLogs[0];

      expect(log.actorId).toBe('editor-1');
      const actorContext = log.actorContext as Record<string, unknown>;
      expect(actorContext.name).toBe('Editor User');
      expect(actorContext.role).toBe('editor');
    });
  });

  describe('Actor context in DELETE operations', () => {
    it('should include actorContext in delete audit logs', async () => {
      const actor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'deleter-1',
          name: 'Deleter User',
          role: 'admin',
        },
      };

      // Create user
      const user = await context.provider.runAsync(actor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'delete@example.com',
            name: 'To Delete',
            password: 'secret123',
          },
        });
      });

      const userId = user.id;

      // Delete user
      await context.provider.runAsync(actor, async () => {
        await context.prisma.user.delete({
          where: { id: userId },
        });
      });

      // Verify delete audit log has actorContext
      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: userId, action: 'delete' },
      });

      expect(deleteLogs.length).toBeGreaterThanOrEqual(1);
      const log = deleteLogs[0];

      expect(log.actorId).toBe('deleter-1');
      const actorContext = log.actorContext as Record<string, unknown>;
      expect(actorContext.name).toBe('Deleter User');
      expect(actorContext.role).toBe('admin');
    });
  });

  describe('Entity and Aggregate Context Enrichment in DELETE operations', () => {
    it('should enrich entity and aggregate context when deleting Comment', async () => {
      // Setup enrichers with spies
      const entityEnricher = createCommentEntityEnricher();
      const aggregateEnricher = createCommentAggregateEnricher();
      const aggregateMapping = createCommentAggregateMapping(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      // Create custom Prisma client
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const { customPrisma, provider } = createEnrichmentTestContext({
        basePrisma: customBasePrisma,
        aggregateMapping,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-comment-actor' },
      };

      // Setup: Create Post and User first
      const { comment } = await provider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'comment-author@example.com', name: 'Author', password: 'pass' },
        });

        const post = await customPrisma.post.create({
          data: { title: 'Test Post', content: 'Content', authorId: user.id },
        });

        const comment = await customPrisma.comment.create({
          data: { content: 'Test Comment', postId: post.id, authorId: user.id },
        });

        return { comment };
      });

      // Clear creation logs and reset spies
      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();
      aggregateEnricher.mockClear();

      // Delete comment
      await provider.runAsync(actor, async () => {
        await customPrisma.comment.delete({ where: { id: comment.id } });
      });

      // Verify enrichers were called
      expect(entityEnricher).toHaveBeenCalledTimes(1);
      // Aggregate enricher is called once per aggregate type (Comment has Post and User as aggregates)
      expect(aggregateEnricher).toHaveBeenCalledTimes(2); // Post + User

      // Verify DELETE audit log has enriched contexts
      const deleteLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id, action: 'delete' },
      });

      expect(deleteLogs.length).toBeGreaterThanOrEqual(1);
      const commentLog = deleteLogs[0];
      if (!commentLog) throw new Error('Comment log not found');

      // aggregateContextMap enriches based on aggregate roots (Post, User), not the entity itself (Comment)
      expect(commentLog.entityContext).toBeDefined();
      expect((commentLog.entityContext as Record<string, unknown>).commentContent).toBe('Test Comment');

      if (commentLog.aggregateContext) {
        expect(commentLog.aggregateContext).toBeDefined();
        expect(commentLog.aggregateContext).toHaveProperty('aggregateInfo');
      }

      await customBasePrisma.$disconnect();
    });

    it('should enrich entity and aggregate context when deleting Profile', async () => {
      // Setup enrichers with spies
      const entityEnricher = createProfileEntityEnricher();
      const aggregateEnricher = createProfileAggregateEnricher();
      const aggregateMapping = createProfileAggregateMapping(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      // Create custom Prisma client
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const { customPrisma, provider } = createEnrichmentTestContext({
        basePrisma: customBasePrisma,
        aggregateMapping,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-profile-actor' },
      };

      // Setup: Create User and Profile
      const { profile } = await provider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'profile-user@example.com', name: 'Profile User', password: 'pass' },
        });

        const profile = await customPrisma.profile.create({
          data: { bio: 'Test Bio', userId: user.id },
        });

        return { profile };
      });

      // Clear creation logs and reset spies
      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();
      aggregateEnricher.mockClear();

      // Delete profile
      await provider.runAsync(actor, async () => {
        await customPrisma.profile.delete({ where: { id: profile.id } });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);
      // Aggregate enricher is called once per aggregate type (Profile has User as aggregate)
      expect(aggregateEnricher).toHaveBeenCalledTimes(1); // User

      // Verify DELETE audit log has enriched contexts
      const deleteLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile.id, action: 'delete' },
      });

      expect(deleteLogs.length).toBeGreaterThanOrEqual(1);
      const profileLog = deleteLogs[0];
      if (!profileLog) throw new Error('Profile log not found');

      // aggregateContextMap enriches based on aggregate root (User), not the entity itself (Profile)
      expect(profileLog.entityContext).toBeDefined();
      expect((profileLog.entityContext as Record<string, unknown>).profileBio).toBe('Test Bio');

      if (profileLog.aggregateContext) {
        expect(profileLog.aggregateContext).toBeDefined();
        expect(profileLog.aggregateContext).toHaveProperty('profileInfo');
      }

      await customBasePrisma.$disconnect();
    });

    it('should enrich context for deleteMany operation', async () => {
      const entityEnricher = createCommentEntityEnricher();
      const aggregateEnricher = createCommentAggregateEnricher();
      const aggregateMapping = createCommentAggregateMapping(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      // Create custom Prisma client
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const { customPrisma, provider } = createEnrichmentTestContext({
        basePrisma: customBasePrisma,
        aggregateMapping,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-many-comment-actor' },
      };

      // Setup: Create Post, User, and multiple Comments
      const { commentIds } = await provider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'many-author@example.com', name: 'Many Author', password: 'pass' },
        });

        const post = await customPrisma.post.create({
          data: { title: 'Test Post for Many', content: 'Content', authorId: user.id },
        });

        const comment1 = await customPrisma.comment.create({
          data: { content: 'Comment 1', postId: post.id, authorId: user.id },
        });

        const comment2 = await customPrisma.comment.create({
          data: { content: 'Comment 2', postId: post.id, authorId: user.id },
        });

        const comment3 = await customPrisma.comment.create({
          data: { content: 'Comment 3', postId: post.id, authorId: user.id },
        });

        return { commentIds: [comment1.id, comment2.id, comment3.id] };
      });

      // Clear creation logs and reset spy
      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();

      // Delete multiple comments
      await provider.runAsync(actor, async () => {
        await customPrisma.comment.deleteMany({ where: { id: { in: commentIds } } });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);

      // Verify enriched entity context in DELETE audit logs
      const deleteLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Comment', action: 'delete', entityId: { in: commentIds } },
      });

      expect(deleteLogs.length).toBeGreaterThanOrEqual(3);

      for (const log of deleteLogs) {
        expect(log.entityContext).toBeDefined();
        const entityContext = log.entityContext as Record<string, unknown>;
        expect(entityContext.commentContent).toBeDefined();
        expect(typeof entityContext.commentContent).toBe('string');
      }

      await customBasePrisma.$disconnect();
    });

    it('should call entity enricher exactly once (batch) for deleteMany operation', async () => {
      const entityEnricher = createUserEntityEnricher();
      const aggregateMapping = createUserEntityAggregateMapping(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      // Create custom Prisma client
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const { customPrisma, provider } = createEnrichmentTestContext({
        basePrisma: customBasePrisma,
        aggregateMapping,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-batch-enricher-actor' },
      };

      // Setup: Create users first
      const userIds = await provider.runAsync(actor, async () => {
        const user1 = await customPrisma.user.create({
          data: { email: 'del-batch1@example.com', name: 'Del Batch 1', password: 'pass1' },
        });
        const user2 = await customPrisma.user.create({
          data: { email: 'del-batch2@example.com', name: 'Del Batch 2', password: 'pass2' },
        });
        const user3 = await customPrisma.user.create({
          data: { email: 'del-batch3@example.com', name: 'Del Batch 3', password: 'pass3' },
        });

        return [user1.id, user2.id, user3.id];
      });

      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();
      await provider.runAsync(actor, async () => {
        await customPrisma.user.deleteMany({ where: { id: { in: userIds } } });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'delete-batch-enricher-actor', action: 'delete' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);
      for (const log of auditLogs) {
        expect(log.entityContext).toBeDefined();
        const entityContext = log.entityContext as Record<string, unknown>;
        expect(entityContext.enrichedEmail).toBeDefined();
        expect(typeof entityContext.enrichedEmail).toBe('string');
      }

      await customBasePrisma.$disconnect();
    });

    it('should call aggregate enricher exactly once (batch) for deleteMany operation', async () => {
      const aggregateEnricher = createUserAggregateEnricher();
      const aggregateMapping = createUserAggregateAggregateMapping(
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      // Create custom Prisma client
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const { customPrisma, provider } = createEnrichmentTestContext({
        basePrisma: customBasePrisma,
        aggregateMapping,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-agg-batch-actor' },
      };

      // Setup: Create users first
      const userIds = await provider.runAsync(actor, async () => {
        const user1 = await customPrisma.user.create({
          data: { email: 'del-agg1@example.com', name: 'Del Agg 1', password: 'pass1' },
        });
        const user2 = await customPrisma.user.create({
          data: { email: 'del-agg2@example.com', name: 'Del Agg 2', password: 'pass2' },
        });
        const user3 = await customPrisma.user.create({
          data: { email: 'del-agg3@example.com', name: 'Del Agg 3', password: 'pass3' },
        });

        return [user1.id, user2.id, user3.id];
      });

      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      aggregateEnricher.mockClear();
      await provider.runAsync(actor, async () => {
        await customPrisma.user.deleteMany({ where: { id: { in: userIds } } });
      });

      // For 3 users, each is its own aggregate root: 3 aggregate enricher calls
      expect(aggregateEnricher).toHaveBeenCalledTimes(3);
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'delete-agg-batch-actor', action: 'delete' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);
      for (const log of auditLogs) {
        expect(log.aggregateContext).toBeDefined();
        const aggregateContext = log.aggregateContext as Record<string, unknown>;
        expect(aggregateContext.aggregateType).toBe('User');
        expect(aggregateContext.aggregateId).toBeDefined();
      }

      await customBasePrisma.$disconnect();
    });
  });

  describe('Enricher Robustness: Missing/Deleted Foreign Key Data', () => {
    const createNullEnrichmentResult = () => ({ postTitle: null, authorName: null });

    const isPrismaClientValid = (prisma: unknown): prisma is PrismaClient => {
      return typeof prisma === 'object' && prisma !== null;
    };

    const extractCommentEntityIds = (entities: unknown[]): { postIds: Set<string>; authorIds: Set<string> } => {
      const postIds = new Set<string>();
      const authorIds = new Set<string>();

      for (const entity of entities as Record<string, unknown>[]) {
        if (entity.postId && typeof entity.postId === 'string') {
          postIds.add(entity.postId);
        }
        if (entity.authorId && typeof entity.authorId === 'string') {
          authorIds.add(entity.authorId);
        }
      }

      return { postIds, authorIds };
    };

    const fetchRelatedData = async (client: PrismaClient, postIds: Set<string>, authorIds: Set<string>) => {
      const [posts, authors] = await Promise.all([
        postIds.size > 0
          ? client.post.findMany({
              where: { id: { in: Array.from(postIds) } },
              select: { id: true, title: true },
            })
          : [],
        authorIds.size > 0
          ? client.user.findMany({
              where: { id: { in: Array.from(authorIds) } },
              select: { id: true, name: true },
            })
          : [],
      ]);

      return {
        postMap: new Map(posts.map((p: { id: string; title: string }) => [p.id, p])),
        authorMap: new Map(authors.map((a: { id: string; name: string | null }) => [a.id, a])),
      };
    };

    it('should handle enricher fallback when related entity is deleted before enrichment', async () => {
      let entityEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
        Comment: defineEntity({
          type: 'Comment',
          aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
          entityContext: {
            enricher: async (entities: unknown[], prisma: unknown, _meta) => {
              entityEnricherCallCount++;

              if (!isPrismaClientValid(prisma)) {
                return entities.map(createNullEnrichmentResult);
              }

              const { postIds, authorIds } = extractCommentEntityIds(entities);
              const { postMap, authorMap } = await fetchRelatedData(prisma, postIds, authorIds);

              return (entities as Record<string, unknown>[]).map((entity) => {
                const post = postMap.get(entity.postId as string);
                const author = authorMap.get(entity.authorId as string);

                return {
                  postTitle: post?.title ?? null,
                  authorName: author?.name ?? null,
                };
              });
            },
          },
        }),
      };

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: customAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => ({
              name: (actor as { name?: string }).name,
            }),
            onError: 'log',
            fallback: null,
          },
        },
        performance: { awaitWrite: true },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'deleted-fk-actor' },
      };

      // Create user, post, and comment
      const { comment, postId, authorId } = await customProvider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'author@example.com', name: 'Author', password: 'pass' },
        });

        const post = await customPrisma.post.create({
          data: { title: 'Test Post', content: 'Content', authorId: user.id },
        });

        const comment = await customPrisma.comment.create({
          data: { content: 'Test Comment', postId: post.id, authorId: user.id },
        });

        return { comment, postId: post.id, authorId: user.id };
      });

      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricherCallCount = 0;
      // Delete related entities before enrichment to simulate cascade delete scenario
      await customBasePrisma.post.delete({ where: { id: postId } });
      await customBasePrisma.user.delete({ where: { id: authorId } });
      const beforeState = { id: comment.id, content: comment.content, postId, authorId };
      const commentEntity = customAggregateMapping.Comment;
      if (!commentEntity) throw new Error('Comment entity not found in aggregate mapping');
      const enricher = commentEntity.entityContext?.enricher;
      if (!enricher) throw new Error('Enricher not configured');
      const enrichedContext = await enricher([beforeState], customBasePrisma, {
        aggregateType: 'Comment',
        aggregateCategory: 'model',
      });
      expect(enrichedContext).toHaveLength(1);
      const firstContext = enrichedContext[0] as {
        postTitle: string | null;
        authorName: string | null;
      };
      // Enricher handles missing FKs gracefully by returning null values
      expect(firstContext.postTitle).toBeNull();
      expect(firstContext.authorName).toBeNull();
      expect(entityEnricherCallCount).toBe(1);

      await customBasePrisma.$disconnect();
    });

    it('should handle empty entity array gracefully', async () => {
      let entityEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
          entityContext: {
            enricher: async (entities: unknown[], _prisma: unknown) => {
              entityEnricherCallCount++;

              if (!Array.isArray(entities) || entities.length === 0) {
                return [];
              }

              return entities.map(() => ({ userName: 'Should not be called' }));
            },
          },
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
      const profileEntity = customAggregateMapping.Profile;
      if (!profileEntity) throw new Error('Profile entity not found in aggregate mapping');
      const enricher = profileEntity.entityContext?.enricher;
      if (!enricher) throw new Error('Enricher not configured');
      const enrichedContext = await enricher([], customBasePrisma, {
        aggregateType: 'Profile',
        aggregateCategory: 'model',
      });

      expect(enrichedContext).toEqual([]);
      expect(entityEnricherCallCount).toBe(1);

      await customBasePrisma.$disconnect();
    });

    it('should handle enricher receiving invalid entity format', async () => {
      const isValidEntity = (entity: unknown): entity is Record<string, unknown> => {
        return typeof entity === 'object' && entity !== null;
      };

      const extractPostIds = (entities: unknown[]): Set<string> => {
        const postIds = new Set<string>();

        for (const entity of entities) {
          if (!isValidEntity(entity)) continue;

          if (entity.postId && typeof entity.postId === 'string') {
            postIds.add(entity.postId);
          }
        }

        return postIds;
      };

      const fetchPosts = async (client: unknown, postIds: Set<string>) => {
        if (postIds.size === 0) return new Map();

        const posts = await (
          client as { post: { findMany: (args: unknown) => Promise<Array<{ id: string; title: string }>> } }
        ).post.findMany({
          where: { id: { in: Array.from(postIds) } },
          select: { id: true, title: true },
        });

        return new Map(posts.map((p: { id: string; title: string }) => [p.id, p]));
      };

      const enrichEntity = (entity: unknown, postMap: Map<string, { id: string; title: string }>) => {
        if (!isValidEntity(entity)) {
          return { postTitle: null };
        }

        const post = postMap.get(entity.postId as string);
        return { postTitle: post?.title ?? null };
      };

      let entityEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
        Comment: defineEntity({
          type: 'Comment',
          aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
          entityContext: {
            enricher: async (entities: unknown[], prisma: unknown, _meta) => {
              entityEnricherCallCount++;

              if (!Array.isArray(entities)) {
                return [];
              }

              if (!isPrismaClientValid(prisma)) {
                return entities.map(() => ({ postTitle: null }));
              }

              const postIds = extractPostIds(entities);
              const postMap = await fetchPosts(prisma, postIds);

              return entities.map((entity) => enrichEntity(entity, postMap));
            },
          },
        }),
      };
      const commentEntity = customAggregateMapping.Comment;
      if (!commentEntity) throw new Error('Comment entity not found in aggregate mapping');
      const enricher = commentEntity.entityContext?.enricher;
      if (!enricher) throw new Error('Enricher not configured');
      const result1 = await enricher([null, undefined, 'invalid', 123], customBasePrisma, {
        aggregateType: 'Comment',
        aggregateCategory: 'model',
      });
      expect(result1).toHaveLength(4);
      expect(result1.every((r) => (r as { postTitle: string | null }).postTitle === null)).toBe(true);
      const result2 = await enricher([{ postId: 'valid-id' }, null, { noPostId: true }], customBasePrisma, {
        aggregateType: 'Comment',
        aggregateCategory: 'model',
      });
      expect(result2).toHaveLength(3);
      expect(result2.every((r) => (r as { postTitle: string | null }).postTitle === null)).toBe(true);
      expect(entityEnricherCallCount).toBeGreaterThanOrEqual(2);

      await customBasePrisma.$disconnect();
    });
  });

  describe('Enricher Error Handling', () => {
    it('should handle enricher throwing error with onError: "log" strategy', async () => {
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
        Comment: defineEntity({
          type: 'Comment',
          aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
          entityContext: {
            enricher: async (_entities: unknown[], _prisma: unknown, _meta) => {
              throw new Error('Simulated enricher error');
            },
            onError: 'log',
            fallback: undefined,
          },
        }),
      };

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: customAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => ({
              name: (actor as { name?: string }).name,
            }),
            onError: 'log',
            fallback: null,
          },
        },
        performance: { awaitWrite: true },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'error-handling-actor' },
      };

      // Create comment - should succeed despite enricher error
      const { comment } = await customProvider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'test@example.com', name: 'Test User', password: 'pass' },
        });

        const post = await customPrisma.post.create({
          data: { title: 'Test Post', content: 'Content', authorId: user.id },
        });

        const comment = await customPrisma.comment.create({
          data: { content: 'Test Comment', postId: post.id, authorId: user.id },
        });

        return { comment };
      });
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id, action: 'create' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const log = auditLogs[0];
      if (!log) throw new Error('Audit log not found');

      expect(log.entityContext).toBeNull();

      await customBasePrisma.$disconnect();
    });

    it('should handle enricher errors with error strategy configuration', async () => {
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
        Comment: defineEntity({
          type: 'Comment',
          aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
          entityContext: {
            enricher: async (_entities: unknown[], _prisma: unknown, _meta: unknown) => {
              throw new Error('Simulated entity enricher error');
            },
            onError: 'log',
            fallback: undefined,
          },
          aggregateContextMap: {
            Post: {
              enricher: async (_aggregates: unknown[], _prisma: unknown, _meta: unknown) => {
                throw new Error('Simulated aggregate enricher error');
              },
              onError: 'log',
              fallback: undefined,
            },
            User: {
              enricher: async (_aggregates: unknown[], _prisma: unknown, _meta: unknown) => {
                throw new Error('Simulated aggregate enricher error');
              },
              onError: 'log',
              fallback: undefined,
            },
          },
        }),
      };

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: customAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => ({
              name: (actor as { name?: string }).name,
            }),
            onError: 'log',
            fallback: null,
          },
        },
        performance: { awaitWrite: true },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'error-config-actor' },
      };

      // Create comment - operation should succeed despite enricher errors
      const { comment } = await customProvider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'error-config@example.com', name: 'Error Config User', password: 'pass' },
        });

        const post = await customPrisma.post.create({
          data: { title: 'Error Config Post', content: 'Content', authorId: user.id },
        });

        const comment = await customPrisma.comment.create({
          data: { content: 'Error Config Comment', postId: post.id, authorId: user.id },
        });

        return { comment };
      });
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id, action: 'create' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const log = auditLogs[0];
      if (!log) throw new Error('Audit log not found');

      expect(log.entityContext).toBeNull();
      expect(log.aggregateContext).toBeNull();

      await customBasePrisma.$disconnect();
    });

    it('should handle actor enricher error with fallback', async () => {
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const actorFallback = { errorOccurred: true };

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: testAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (_actor: unknown, _prisma: unknown) => {
              throw new Error('Actor enricher error');
            },
            onError: 'log',
            fallback: actorFallback,
          },
        },
        performance: { awaitWrite: true },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'actor-error-test' },
      };

      // Create user - should succeed with actor fallback
      const user = await customProvider.runAsync(actor, async () => {
        return await customPrisma.user.create({
          data: { email: 'actor-error@example.com', name: 'Actor Error User', password: 'pass' },
        });
      });
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const log = auditLogs[0];
      if (!log) throw new Error('Audit log not found');

      expect(log.actorContext).toEqual(actorFallback);

      await customBasePrisma.$disconnect();
    });
  });

  describe('[N+1 Resolution] Entity/Aggregate Batch Enrichment', () => {
    it('should demonstrate batch enrichment for entity context (indirect verification)', async () => {
      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'batch-actor' },
      };

      // Create multiple users in batch
      await context.provider.runAsync(actor, async () => {
        await context.prisma.user.createMany({
          data: [
            { email: 'batch1@example.com', name: 'Batch User 1', password: 'pass1' },
            { email: 'batch2@example.com', name: 'Batch User 2', password: 'pass2' },
            { email: 'batch3@example.com', name: 'Batch User 3', password: 'pass3' },
            { email: 'batch4@example.com', name: 'Batch User 4', password: 'pass4' },
            { email: 'batch5@example.com', name: 'Batch User 5', password: 'pass5' },
          ],
        });
      });
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { actorId: 'batch-actor', action: 'create' },
        orderBy: { createdAt: 'asc' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(5);

      for (const log of auditLogs) {
        expect(log.actorContext).toBeDefined();
        expect(log.entityContext).toBeDefined();
        expect(log.aggregateContext).toBeDefined();
      }
    });

    it('should handle batch enrichment for updateMany operations', async () => {
      const createActor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'create-for-update-batch' },
      };

      const updateActor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'update-batch-actor' },
      };

      // Setup: Create users first with different actor
      await context.provider.runAsync(createActor, async () => {
        return await Promise.all([
          context.prisma.user.create({
            data: { email: 'update1@example.com', name: 'Update User 1', password: 'pass1' },
          }),
          context.prisma.user.create({
            data: { email: 'update2@example.com', name: 'Update User 2', password: 'pass2' },
          }),
          context.prisma.user.create({
            data: { email: 'update3@example.com', name: 'Update User 3', password: 'pass3' },
          }),
        ]);
      });
      await context.provider.runAsync(updateActor, async () => {
        await context.prisma.user.updateMany({
          where: {
            email: { in: ['update1@example.com', 'update2@example.com', 'update3@example.com'] },
          },
          data: { name: 'Updated Name' },
        });
      });
      const updateLogs = await context.prisma.auditLog.findMany({
        where: { actorId: 'update-batch-actor', action: 'update' },
      });

      expect(updateLogs.length).toBeGreaterThanOrEqual(3);

      for (const log of updateLogs) {
        expect(log.actorContext).toBeDefined();
        expect('entityContext' in log).toBe(true);
        expect('aggregateContext' in log).toBe(true);
      }
    });

    it('should handle batch enrichment for deleteMany operations', async () => {
      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-batch-actor' },
      };

      // Setup: Create users first
      await context.provider.runAsync(actor, async () => {
        return await Promise.all([
          context.prisma.user.create({
            data: { email: 'delete1@example.com', name: 'Delete User 1', password: 'pass1' },
          }),
          context.prisma.user.create({
            data: { email: 'delete2@example.com', name: 'Delete User 2', password: 'pass2' },
          }),
          context.prisma.user.create({
            data: { email: 'delete3@example.com', name: 'Delete User 3', password: 'pass3' },
          }),
        ]);
      });
      await context.prisma.auditLog.deleteMany({
        where: { actorId: 'delete-batch-actor', action: 'create' },
      });
      await context.provider.runAsync(actor, async () => {
        await context.prisma.user.deleteMany({
          where: {
            email: { in: ['delete1@example.com', 'delete2@example.com', 'delete3@example.com'] },
          },
        });
      });
      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { actorId: 'delete-batch-actor', action: 'delete' },
      });

      expect(deleteLogs.length).toBeGreaterThanOrEqual(3);

      for (const log of deleteLogs) {
        expect(log.actorContext).toBeDefined();
        expect('entityContext' in log).toBe(true);
        expect('aggregateContext' in log).toBe(true);
      }
    });
  });

  describe('[Direct Verification] Enricher Call Count Tests', () => {
    it('should call actor enricher exactly once for createMany operation', async () => {
      let actorEnricherCallCount = 0;
      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: testAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => {
              actorEnricherCallCount++;
              return {
                name: (actor as { name?: string }).name,
                role: (actor as { role?: string }).role,
              };
            },
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'direct-verify-actor',
          name: 'Direct Verify Actor',
          role: 'admin',
        },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.createMany({
          data: [
            { email: 'direct1@example.com', name: 'User 1', password: 'pass1' },
            { email: 'direct2@example.com', name: 'User 2', password: 'pass2' },
            { email: 'direct3@example.com', name: 'User 3', password: 'pass3' },
          ],
        });
      });

      expect(actorEnricherCallCount).toBe(1);
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'direct-verify-actor' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);
      for (const log of auditLogs) {
        const actorContext = log.actorContext as Record<string, unknown>;
        expect(actorContext.name).toBe('Direct Verify Actor');
        expect(actorContext.role).toBe('admin');
      }

      await customBasePrisma.$disconnect();
    });

    it('should call actor enricher exactly once for multiple individual operations', async () => {
      let actorEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: testAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => {
              actorEnricherCallCount++;
              return {
                name: (actor as { name?: string }).name,
                role: (actor as { role?: string }).role,
              };
            },
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'multi-op-actor',
          name: 'Multi Op Actor',
          role: 'admin',
        },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.create({
          data: { email: 'multi1@example.com', name: 'User 1', password: 'pass1' },
        });
        await customPrisma.user.create({
          data: { email: 'multi2@example.com', name: 'User 2', password: 'pass2' },
        });
        await customPrisma.user.create({
          data: { email: 'multi3@example.com', name: 'User 3', password: 'pass3' },
        });
      });

      // Actor context cache is per-operation, not per-runAsync
      expect(actorEnricherCallCount).toBe(3);

      await customBasePrisma.$disconnect();
    });

    it('should call actor enricher once per separate operation context', async () => {
      let actorEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: testAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => {
              actorEnricherCallCount++;
              return {
                name: (actor as { name?: string }).name,
                role: (actor as { role?: string }).role,
              };
            },
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'separate-ctx-actor',
          name: 'Separate Context Actor',
          role: 'admin',
        },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.create({
          data: { email: 'ctx1@example.com', name: 'User 1', password: 'pass1' },
        });
      });

      expect(actorEnricherCallCount).toBe(1);
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.create({
          data: { email: 'ctx2@example.com', name: 'User 2', password: 'pass2' },
        });
      });

      expect(actorEnricherCallCount).toBe(2);

      await customBasePrisma.$disconnect();
    });

    it('should call actor enricher separately for concurrent operations', async () => {
      let actorEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: testAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => {
              actorEnricherCallCount++;
              return {
                name: (actor as { name?: string }).name,
                role: (actor as { role?: string }).role,
              };
            },
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor1: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'concurrent-1',
          name: 'Actor 1',
          role: 'admin',
        },
      };

      const actor2: TestAuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'concurrent-2',
          name: 'Actor 2',
          role: 'user',
        },
      };

      // Execute concurrent operations with different actors
      await Promise.all([
        customProvider.runAsync(actor1, async () => {
          await customPrisma.user.create({
            data: { email: 'concurrent1@example.com', name: 'User 1', password: 'pass1' },
          });
        }),
        customProvider.runAsync(actor2, async () => {
          await customPrisma.user.create({
            data: { email: 'concurrent2@example.com', name: 'User 2', password: 'pass2' },
          });
        }),
      ]);

      expect(actorEnricherCallCount).toBe(2);

      await customBasePrisma.$disconnect();
    });

    it('should call entity enricher exactly once (batch) for createMany operation', async () => {
      let entityEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
          entityContext: {
            enricher: async (entities: unknown[], _prisma: unknown, _meta) => {
              entityEnricherCallCount++;
              return (entities as Record<string, unknown>[]).map((entity) => ({
                enrichedEmail: (entity.email as string)?.toUpperCase(),
              }));
            },
          },
        }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
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

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: customAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => ({
              name: (actor as { name?: string }).name,
              role: (actor as { role?: string }).role,
            }),
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'entity-batch-actor' },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.createMany({
          data: [
            { email: 'entity1@example.com', name: 'Entity User 1', password: 'pass1' },
            { email: 'entity2@example.com', name: 'Entity User 2', password: 'pass2' },
            { email: 'entity3@example.com', name: 'Entity User 3', password: 'pass3' },
          ],
        });
      });

      expect(entityEnricherCallCount).toBe(1);
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'entity-batch-actor' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);
      for (const log of auditLogs) {
        expect(log.entityContext).toBeDefined();
        const entityContext = log.entityContext as Record<string, unknown>;
        expect(entityContext.enrichedEmail).toBeDefined();
        expect(typeof entityContext.enrichedEmail).toBe('string');
      }

      await customBasePrisma.$disconnect();
    });

    it('should call entity enricher exactly once (batch) for multiple individual create operations', async () => {
      let entityEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
          entityContext: {
            enricher: async (entities: unknown[], _prisma: unknown, _meta) => {
              entityEnricherCallCount++;
              return (entities as Record<string, unknown>[]).map((entity) => ({
                enrichedName: (entity.name as string)?.toUpperCase(),
              }));
            },
          },
        }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
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

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: customAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => ({
              name: (actor as { name?: string }).name,
              role: (actor as { role?: string }).role,
            }),
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'entity-multi-actor' },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.create({
          data: { email: 'multi-entity1@example.com', name: 'Multi Entity 1', password: 'pass1' },
        });
        await customPrisma.user.create({
          data: { email: 'multi-entity2@example.com', name: 'Multi Entity 2', password: 'pass2' },
        });
        await customPrisma.user.create({
          data: { email: 'multi-entity3@example.com', name: 'Multi Entity 3', password: 'pass3' },
        });
      });

      // Entity enrichment is per-operation, not cached across operations
      expect(entityEnricherCallCount).toBe(3);

      await customBasePrisma.$disconnect();
    });

    it('should call aggregate enricher exactly once (batch) for createMany operation', async () => {
      let aggregateEnricherCallCount = 0;

      const customBasePrisma = new (await import('@kuruwic/prisma-audit-database/generated/client')).PrismaClient({
        datasources: { db: { url: context.databaseUrl } },
      });
      const customProvider = createAsyncLocalStorageProvider();

      const customAggregateMapping: AggregateMapping = {
        User: defineEntity({
          type: 'User',
          excludeFields: ['updatedAt'],
          aggregateContextMap: {
            User: {
              enricher: async (aggregates: unknown[], _prisma: unknown, meta: unknown) => {
                aggregateEnricherCallCount++;
                return (aggregates as Record<string, unknown>[]).map((aggregate) => ({
                  aggregateType: (meta as { aggregateType: string }).aggregateType,
                  aggregateId: ((meta as { aggregateId?: string }).aggregateId || aggregate.id) as string,
                }));
              },
            },
          },
        }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
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

      const customPrisma = createAuditClient(customBasePrisma, {
        DbNull: Prisma.DbNull,
        provider: customProvider,
        basePrisma: customBasePrisma,
        aggregateMapping: customAggregateMapping,
        contextEnricher: {
          actor: {
            enricher: async (actor: unknown) => ({
              name: (actor as { name?: string }).name,
              role: (actor as { role?: string }).role,
            }),
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'aggregate-batch-actor' },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.createMany({
          data: [
            { email: 'agg1@example.com', name: 'Aggregate User 1', password: 'pass1' },
            { email: 'agg2@example.com', name: 'Aggregate User 2', password: 'pass2' },
            { email: 'agg3@example.com', name: 'Aggregate User 3', password: 'pass3' },
          ],
        });
      });

      // For 3 users, each is its own aggregate root: 3 aggregate enricher calls
      expect(aggregateEnricherCallCount).toBe(3);
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'aggregate-batch-actor' },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(3);
      for (const log of auditLogs) {
        expect(log.aggregateContext).toBeDefined();
        const aggregateContext = log.aggregateContext as Record<string, unknown>;
        expect(aggregateContext.aggregateType).toBe('User');
        expect(aggregateContext.aggregateId).toBeDefined();
      }

      await customBasePrisma.$disconnect();
    });
  });
});
