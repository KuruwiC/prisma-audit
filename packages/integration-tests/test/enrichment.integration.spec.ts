import type { AuditActor, AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { EntityMap } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCommentAggregateEnricher,
  createCommentEntities,
  createCommentEntityEnricher,
  createProfileAggregateEnricher,
  createProfileEntities,
  createProfileEntityEnricher,
  createUserAggregateContextEntities,
  createUserAggregateEnricher,
  createUserEntityContextEntities,
  createUserEntityEnricher,
} from './helpers/enrichment-test-helpers.js';
import { createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

type TestAuditActor = AuditActor & {
  role?: string; // Custom property for enrichment testing
};

type TestAuditContext = Omit<AuditContext, 'actor'> & {
  actor: TestAuditActor;
};

type ClientOptions = Omit<
  Parameters<typeof createAuditClient<PrismaClient, AuditModelName>>[1],
  'Prisma' | 'schema' | 'contextProvider'
>;

/** Orders values by their JSON text, for comparing rows read in no fixed order */
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));

describe('Context Enrichment Integration', () => {
  const context = setupTestContext();
  const openedBaseClients: PrismaClient[] = [];

  /**
   * Opens an awaited audited client with its own provider on a fresh Prisma client, so the
   * mapping and enrichers under test cannot leak into other tests. The Prisma client is
   * disconnected after the test, whether it passed or not.
   */
  const openClient = (options: ClientOptions) => {
    const basePrisma = createBasePrisma();
    openedBaseClients.push(basePrisma);
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      write: { awaited: true },
      ...options,
    });
    return { basePrisma, prisma, provider };
  };

  afterEach(async () => {
    await Promise.all(openedBaseClients.splice(0).map((client) => client.$disconnect()));
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

      const adminLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: adminUser.id },
      });
      expect(adminLogs).toHaveLength(1);
      const adminLog = adminLogs[0];
      expect(adminLog.actorId).toBe('admin-1');
      const adminContext = adminLog.actorContext as Record<string, unknown>;
      expect(adminContext.name).toBe('Admin User');
      expect(adminContext.role).toBe('admin');

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

      const user = await context.provider.runAsync(actor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'edit@example.com',
            name: 'Original Name',
            password: 'secret123',
          },
        });
      });

      await context.provider.runAsync(actor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(updateLogs).toHaveLength(1);
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

      await context.provider.runAsync(actor, async () => {
        await context.prisma.user.delete({
          where: { id: userId },
        });
      });

      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: userId, action: 'delete' },
      });

      expect(deleteLogs).toHaveLength(1);
      const log = deleteLogs[0];

      expect(log.actorId).toBe('deleter-1');
      const actorContext = log.actorContext as Record<string, unknown>;
      expect(actorContext.name).toBe('Deleter User');
      expect(actorContext.role).toBe('admin');
    });
  });

  describe('Entity and Aggregate Context Enrichment in DELETE operations', () => {
    it('should enrich entity and aggregate context when deleting Comment', async () => {
      const entityEnricher = createCommentEntityEnricher();
      const aggregateEnricher = createCommentAggregateEnricher();
      const entities = createCommentEntities(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      const { basePrisma: customBasePrisma, prisma: customPrisma, provider } = openClient({ entities });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-comment-actor' },
      };

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

      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();
      aggregateEnricher.mockClear();

      await provider.runAsync(actor, async () => {
        await customPrisma.comment.delete({ where: { id: comment.id } });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);
      // Aggregate enricher is called once per aggregate type (Comment has Post and User as aggregates)
      expect(aggregateEnricher).toHaveBeenCalledTimes(2); // Post + User

      const deleteLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id, action: 'delete' },
      });

      // The Comment aggregate log carries no aggregateContext; each to() projection log carries aggregateInfo
      expect(
        deleteLogs
          .map((log) => [log.aggregateType, log.entityContext, log.aggregateContext])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ['Comment', { commentContent: 'Test Comment' }, null],
        ['Post', { commentContent: 'Test Comment' }, { aggregateInfo: `Comment ${comment.id}` }],
        ['User', { commentContent: 'Test Comment' }, { aggregateInfo: `Comment ${comment.id}` }],
      ]);
    });

    it('should enrich entity and aggregate context when deleting Profile', async () => {
      const entityEnricher = createProfileEntityEnricher();
      const aggregateEnricher = createProfileAggregateEnricher();
      const entities = createProfileEntities(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      const { basePrisma: customBasePrisma, prisma: customPrisma, provider } = openClient({ entities });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-profile-actor' },
      };

      const { user, profile } = await provider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'profile-user@example.com', name: 'Profile User', password: 'pass' },
        });

        const profile = await customPrisma.profile.create({
          data: { bio: 'Test Bio', userId: user.id },
        });

        return { user, profile };
      });

      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();
      aggregateEnricher.mockClear();

      await provider.runAsync(actor, async () => {
        await customPrisma.profile.delete({ where: { id: profile.id } });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);
      // Aggregate enricher is called once per aggregate type (Profile has User as aggregate)
      expect(aggregateEnricher).toHaveBeenCalledTimes(1); // User

      const deleteLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Profile', entityId: profile.id, action: 'delete' },
      });

      // The Profile aggregate log carries no aggregateContext; the to() projection log carries profileInfo
      expect(
        deleteLogs
          .map((log) => [log.aggregateType, log.entityContext, log.aggregateContext])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ['Profile', { profileBio: 'Test Bio' }, null],
        ['User', { profileBio: 'Test Bio' }, { profileInfo: `Profile for user ${user.id}` }],
      ]);
    });

    it('should call the entity enricher once with the three deleted comments for a deleteMany and enrich every row of each', async () => {
      const entityEnricher = createCommentEntityEnricher();
      const aggregateEnricher = createCommentAggregateEnricher();
      const entities = createCommentEntities(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      const { basePrisma: customBasePrisma, prisma: customPrisma, provider } = openClient({ entities });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-many-comment-actor' },
      };

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

      await customBasePrisma.auditLog.deleteMany({ where: { action: 'create' } });
      entityEnricher.mockClear();

      await provider.runAsync(actor, async () => {
        await customPrisma.comment.deleteMany({ where: { id: { in: commentIds } } });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);
      expect(entityEnricher.mock.calls[0]?.[0]).toHaveLength(3);

      const deleteLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Comment', action: 'delete', entityId: { in: commentIds } },
      });

      // Each of the 3 comments is logged under its own aggregate, the Post and the User
      expect(deleteLogs).toHaveLength(9);
      for (const aggregateType of ['Comment', 'Post', 'User']) {
        expect(
          deleteLogs
            .filter((log) => log.aggregateType === aggregateType)
            .map((log) => log.entityContext)
            .sort(byJson),
        ).toEqual([{ commentContent: 'Comment 1' }, { commentContent: 'Comment 2' }, { commentContent: 'Comment 3' }]);
      }
    });

    it('should call aggregate enricher exactly once (batch) for deleteMany operation', async () => {
      const aggregateEnricher = createUserAggregateEnricher();
      const entities = createUserAggregateContextEntities(
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      );

      const { basePrisma: customBasePrisma, prisma: customPrisma, provider } = openClient({ entities });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'delete-agg-batch-actor' },
      };

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

      // All 3 users share aggregateType "User" → enricher called once with all 3 entities
      expect(aggregateEnricher).toHaveBeenCalledTimes(1);
      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'delete-agg-batch-actor', action: 'delete' },
      });

      expect(auditLogs).toHaveLength(3);
      expect(auditLogs.map((log) => log.aggregateId).sort()).toEqual([...userIds].sort());
      for (const log of auditLogs) {
        expect(log.aggregateContext).toEqual({ aggregateType: 'User', aggregateId: log.aggregateId });
      }
    });

    it('should run the entity enricher after the delete, when the rows that depended on the deleted row are already gone', async () => {
      const commentCounts: number[] = [];
      const {
        basePrisma,
        prisma: customPrisma,
        provider,
      } = openClient({
        entities: {
          ...testEntities,
          Post: defineEntity({
            type: 'Post',
            aggregates: [to('User', foreignKey('authorId'))],
            entityContext: {
              enricher: async (posts, prisma) =>
                Promise.all(
                  posts.map(async (post) => {
                    const commentCount = await prisma.comment.count({ where: { postId: post.id as string } });
                    commentCounts.push(commentCount);
                    return { commentCount };
                  }),
                ),
            },
          }),
        },
      });

      const author = await basePrisma.user.create({
        data: { email: 'cascade-author@example.com', name: 'Cascade Author', password: 'pass' },
      });
      const post = await basePrisma.post.create({
        data: { title: 'Cascade Post', content: 'Content', authorId: author.id },
      });
      await basePrisma.comment.createMany({
        data: [
          { content: 'Comment 1', postId: post.id, authorId: author.id },
          { content: 'Comment 2', postId: post.id, authorId: author.id },
        ],
      });
      expect(await basePrisma.comment.count({ where: { postId: post.id } })).toBe(2);

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'cascade-delete-actor' },
      };
      await provider.runAsync(actor, async () => {
        await customPrisma.post.delete({ where: { id: post.id } });
      });

      // The comments are removed with the post, so the enricher finds none of them
      expect(commentCounts).toEqual([0]);
      const deleteLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, action: 'delete' },
      });
      expect(
        deleteLogs
          .map((log) => [log.aggregateType, log.entityContext])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ['Post', { commentCount: 0 }],
        ['User', { commentCount: 0 }],
      ]);
    });
  });

  describe('Enricher Error Handling', () => {
    it("should write a Comment create without entity context when its entity enricher throws under onError: 'log'", async () => {
      const customEntities: EntityMap = {
        User: defineEntity({ type: 'User', diffExcludeFields: ['updatedAt'] }),
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
            enricher: async (_entities: unknown[], _prisma: unknown) => {
              throw new Error('Simulated enricher error');
            },
            onError: 'log',
            fallback: undefined,
          },
        }),
      };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
        actorContext: {
          enricher: async (actor: unknown) => ({
            name: (actor as { name?: string }).name,
          }),
          onError: 'log',
          fallback: null,
        },
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

      // The Comment create is logged under its own, the Post and the User aggregate
      expect(auditLogs).toHaveLength(3);
      for (const log of auditLogs) {
        expect(log.entityContext).toBeNull();
      }
    });

    it("should write a Comment create without entity or aggregate context when its enrichers throw under onError: 'log'", async () => {
      const customEntities: EntityMap = {
        User: defineEntity({ type: 'User', diffExcludeFields: ['updatedAt'] }),
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
          aggregates: [
            to('Post', foreignKey('postId'), {
              aggregateContext: {
                enricher: async (_rows: unknown[], _prisma: unknown, _meta: unknown) => {
                  throw new Error('Simulated aggregate enricher error');
                },
                onError: 'log',
                fallback: undefined,
              },
            }),
            to('User', foreignKey('authorId'), {
              aggregateContext: {
                enricher: async (_rows: unknown[], _prisma: unknown, _meta: unknown) => {
                  throw new Error('Simulated aggregate enricher error');
                },
                onError: 'log',
                fallback: undefined,
              },
            }),
          ],
          entityContext: {
            enricher: async (_entities: unknown[], _prisma: unknown) => {
              throw new Error('Simulated entity enricher error');
            },
            onError: 'log',
            fallback: undefined,
          },
        }),
      };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
        actorContext: {
          enricher: async (actor: unknown) => ({
            name: (actor as { name?: string }).name,
          }),
          onError: 'log',
          fallback: null,
        },
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

      expect(auditLogs).toHaveLength(3);
      for (const log of auditLogs) {
        expect(log.entityContext).toBeNull();
        expect(log.aggregateContext).toBeNull();
      }
    });

    it('should handle actor enricher error with fallback', async () => {
      const actorFallback = { errorOccurred: true };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: testEntities,
        actorContext: {
          enricher: async (_actor: unknown, _prisma: unknown) => {
            throw new Error('Actor enricher error');
          },
          onError: 'log',
          fallback: actorFallback,
        },
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

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]?.actorContext).toEqual(actorFallback);
    });

    describe("an entity enricher that throws under the default onError ('throw')", () => {
      const enricherError = new Error('entity enricher failed');
      const failingEntityMapping: EntityMap = {
        ...testEntities,
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
          entityContext: {
            enricher: async () => {
              throw enricherError;
            },
          },
        }),
      };
      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'entity-fail-actor' },
      };

      it('keeps the committed row and drops its audit rows outside a transaction, reporting diff-generation once', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const observer = vi.fn();
        const {
          basePrisma,
          prisma: customPrisma,
          provider,
        } = openClient({
          entities: failingEntityMapping,
          errorObserver: observer,
        });

        try {
          const user = await provider.runAsync(actor, async () =>
            customPrisma.user.create({
              data: { email: 'entity-fail@example.com', name: 'Entity Fail', password: 'pass' },
            }),
          );

          expect(await basePrisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
          expect(await basePrisma.auditLog.count()).toBe(0);
          expect(observer).toHaveBeenCalledTimes(1);
          expect(observer).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'diff-generation', modelName: 'User', error: enricherError }),
          );
        } finally {
          consoleError.mockRestore();
        }
      });

      it('rolls the write back with its audit rows inside an interactive transaction', async () => {
        const observer = vi.fn();
        const {
          basePrisma,
          prisma: customPrisma,
          provider,
        } = openClient({
          entities: failingEntityMapping,
          errorObserver: observer,
        });

        await expect(
          provider.runAsync(actor, async () =>
            customPrisma.$transaction(async (tx) =>
              tx.user.create({
                data: { email: 'entity-fail-tx@example.com', name: 'Entity Fail Tx', password: 'pass' },
              }),
            ),
          ),
        ).rejects.toThrow('entity enricher failed');

        expect(await basePrisma.user.count()).toBe(0);
        expect(await basePrisma.auditLog.count()).toBe(0);
        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(
          expect.objectContaining({ phase: 'diff-generation', modelName: 'User', error: enricherError }),
        );
      });
    });
  });

  describe('[N+1 Resolution] Entity/Aggregate Batch Enrichment', () => {
    it('should call the entity enricher once for an updateMany and enrich every updated row', async () => {
      const entityEnricher = createUserEntityEnricher();
      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider,
      } = openClient({
        entities: createUserEntityContextEntities(
          entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        ),
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'update-batch-actor' },
      };
      const emails = ['update1@example.com', 'update2@example.com', 'update3@example.com'];

      await provider.runAsync(actor, async () => {
        await customPrisma.user.createMany({
          data: emails.map((email, i) => ({ email, name: `Update User ${i + 1}`, password: `pass${i + 1}` })),
        });
      });
      await customBasePrisma.auditLog.deleteMany();
      entityEnricher.mockClear();

      await provider.runAsync(actor, async () => {
        await customPrisma.user.updateMany({
          where: { email: { in: emails } },
          data: { name: 'Updated Name' },
        });
      });

      expect(entityEnricher).toHaveBeenCalledTimes(1);

      const updateLogs = await customBasePrisma.auditLog.findMany({
        where: { action: 'update' },
      });

      expect(updateLogs).toHaveLength(3);
      expect(updateLogs.map((log) => log.entityContext).sort(byJson)).toEqual(
        emails.map((email) => ({ enrichedEmail: email.toUpperCase() })),
      );
    });
  });

  describe('[Direct Verification] Enricher Call Count Tests', () => {
    it('should call actor enricher exactly once for createMany operation', async () => {
      let actorEnricherCallCount = 0;

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: testEntities,
        actorContext: {
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

      expect(auditLogs).toHaveLength(3);
      for (const log of auditLogs) {
        const actorContext = log.actorContext as Record<string, unknown>;
        expect(actorContext.name).toBe('Direct Verify Actor');
        expect(actorContext.role).toBe('admin');
      }
    });

    it('should call the actor enricher once per operation for multiple individual operations', async () => {
      let actorEnricherCallCount = 0;

      const { prisma: customPrisma, provider: customProvider } = openClient({
        entities: testEntities,
        actorContext: {
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
    });

    it('should call actor enricher separately for concurrent operations', async () => {
      let actorEnricherCallCount = 0;

      const { prisma: customPrisma, provider: customProvider } = openClient({
        entities: testEntities,
        actorContext: {
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
    });

    it('should call entity enricher exactly once (batch) for createMany operation', async () => {
      let entityEnricherCallCount = 0;

      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
          entityContext: {
            enricher: async (entities: unknown[], _prisma: unknown) => {
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

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
        actorContext: {
          enricher: async (actor: unknown) => ({
            name: (actor as { name?: string }).name,
            role: (actor as { role?: string }).role,
          }),
          onError: 'log',
          fallback: null,
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

      expect(auditLogs).toHaveLength(3);
      expect(auditLogs.map((log) => log.entityContext).sort(byJson)).toEqual(
        ['entity1@example.com', 'entity2@example.com', 'entity3@example.com'].map((email) => ({
          enrichedEmail: email.toUpperCase(),
        })),
      );
    });

    it('should call the entity enricher once per operation for multiple individual create operations', async () => {
      let entityEnricherCallCount = 0;

      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
          entityContext: {
            enricher: async (entities: unknown[], _prisma: unknown) => {
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

      const { prisma: customPrisma, provider: customProvider } = openClient({
        entities: customEntities,
        actorContext: {
          enricher: async (actor: unknown) => ({
            name: (actor as { name?: string }).name,
            role: (actor as { role?: string }).role,
          }),
          onError: 'log',
          fallback: null,
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
    });
  });

  describe('[Batch Optimization] Aggregate enricher should be batched per aggregateType', () => {
    it('should call aggregate enricher once per aggregateType for createMany (same aggregateType)', async () => {
      let aggregateEnricherCallCount = 0;
      const receivedEntityCounts: number[] = [];

      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
          selfAggregate: {
            aggregateContext: {
              enricher: async (rows, _prisma, meta) => {
                aggregateEnricherCallCount++;
                receivedEntityCounts.push(rows.length);
                return rows.map((row) => ({
                  aggregateType: meta.aggregateType,
                  aggregateId: row.id as string,
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

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
        actorContext: {
          enricher: async (actor: unknown) => ({
            name: (actor as { name?: string }).name,
          }),
          onError: 'log',
          fallback: null,
        },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'batch-agg-opt-actor' },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.user.createMany({
          data: [
            { email: 'batch-opt-1@example.com', name: 'User 1', password: 'pass1' },
            { email: 'batch-opt-2@example.com', name: 'User 2', password: 'pass2' },
            { email: 'batch-opt-3@example.com', name: 'User 3', password: 'pass3' },
          ],
        });
      });

      // All 3 users share aggregateType "User" → enricher called once with all 3 entities
      expect(aggregateEnricherCallCount).toBe(1);
      expect(receivedEntityCounts).toEqual([3]);

      const auditLogs = await customBasePrisma.auditLog.findMany({
        where: { actorId: 'batch-agg-opt-actor' },
      });
      expect(auditLogs).toHaveLength(3);
      for (const log of auditLogs) {
        expect(log.aggregateContext).toBeDefined();
        const aggregateContext = log.aggregateContext as Record<string, unknown>;
        expect(aggregateContext.aggregateType).toBe('User');
      }
    });

    it('should call aggregate enricher once per distinct aggregateType for createMany (multiple aggregateTypes)', async () => {
      const enricherCallsByType: Record<string, number> = {};

      const sharedEnricher = async (
        rows: Record<string, unknown>[],
        _prisma: unknown,
        meta: { aggregateType: string; aggregateCategory: string; aggregateIds: string[] },
      ) => {
        const aggregateType = meta.aggregateType;
        enricherCallsByType[aggregateType] = (enricherCallsByType[aggregateType] || 0) + 1;
        return rows.map((row) => ({
          aggregateType,
          entityId: row.id as string,
        }));
      };
      // One shared projection context attached to every aggregate target (self, Post, User)
      const sharedContext = { enricher: sharedEnricher };

      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
        }),
        Profile: defineEntity({
          type: 'Profile',
          aggregates: [to('User', foreignKey('userId'))],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
          diffExcludeFields: ['updatedAt'],
        }),
        Comment: defineEntity({
          type: 'Comment',
          aggregates: [
            to('Post', foreignKey('postId'), { aggregateContext: sharedContext }),
            to('User', foreignKey('authorId'), { aggregateContext: sharedContext }),
          ],
          selfAggregate: { aggregateContext: sharedContext },
        }),
      };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
      });

      const author = await customBasePrisma.user.create({
        data: { email: 'batch-author@example.com', name: 'Author', password: 'pass' },
      });
      const post = await customBasePrisma.post.create({
        data: { title: 'Test Post', authorId: author.id },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'batch-agg-multi-actor' },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.comment.createMany({
          data: [
            { content: 'Comment 1', postId: post.id, authorId: author.id },
            { content: 'Comment 2', postId: post.id, authorId: author.id },
            { content: 'Comment 3', postId: post.id, authorId: author.id },
          ],
        });
      });

      // Comment has 3 aggregateTypes: Comment (self), Post, User
      // Each aggregateType should be called exactly once regardless of entity count
      expect(enricherCallsByType.Comment).toBe(1);
      expect(enricherCallsByType.Post).toBe(1);
      expect(enricherCallsByType.User).toBe(1);
    });
  });

  describe('[Aggregate Context] Root-side aggregateContext and projection merge semantics', () => {
    it('should apply root-side aggregateContext to self logs and child-projected logs', async () => {
      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
          aggregateContext: {
            enricher: async (userIds, _prisma) => userIds.map((id) => ({ rootUserId: id, source: 'root' })),
          },
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
        }),
      };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'root-agg-ctx-actor' },
      };

      const { user, post } = await customProvider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'root-ctx@example.com', name: 'Root Ctx User', password: 'pass' },
        });
        const post = await customPrisma.post.create({
          data: { title: 'Root Ctx Post', content: 'Content', authorId: user.id },
        });
        return { user, post };
      });

      // Self log: User create projected onto itself gets the root-side context
      const userSelfLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, aggregateType: 'User', action: 'create' },
      });
      expect(userSelfLogs).toHaveLength(1);
      expect(userSelfLogs[0]?.aggregateContext).toEqual({ rootUserId: user.id, source: 'root' });

      // Child-projected log: Post create projected onto User gets the same root-side context
      const postUserLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, aggregateType: 'User', action: 'create' },
      });
      expect(postUserLogs).toHaveLength(1);
      expect(postUserLogs[0]?.aggregateContext).toEqual({ rootUserId: user.id, source: 'root' });

      // Post self log: Post root has no aggregateContext and no projection context
      const postSelfLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, aggregateType: 'Post', action: 'create' },
      });
      expect(postSelfLogs).toHaveLength(1);
      expect(postSelfLogs[0]?.aggregateContext).toBeNull();
    });

    it('should merge projection context over root-side aggregateContext (projection keys win)', async () => {
      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
          aggregateContext: {
            enricher: async (userIds, _prisma) => userIds.map(() => ({ source: 'root', rootOnly: true })),
          },
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to('User', foreignKey('authorId'), {
              aggregateContext: {
                enricher: async (posts, _prisma, _meta) => posts.map(() => ({ source: 'projection' })),
              },
            }),
          ],
        }),
      };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'merge-precedence-actor' },
      };

      const { user, post } = await customProvider.runAsync(actor, async () => {
        const user = await customPrisma.user.create({
          data: { email: 'merge@example.com', name: 'Merge User', password: 'pass' },
        });
        const post = await customPrisma.post.create({
          data: { title: 'Merge Post', content: 'Content', authorId: user.id },
        });
        return { user, post };
      });

      // Projection-provided key overrides the root-side key; root-only keys are preserved
      const postUserLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, aggregateType: 'User', action: 'create' },
      });
      expect(postUserLogs).toHaveLength(1);
      expect(postUserLogs[0]?.aggregateContext).toEqual({ source: 'projection', rootOnly: true });

      // User self log has no projection context → root-side context only
      const userSelfLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, aggregateType: 'User', action: 'create' },
      });
      expect(userSelfLogs).toHaveLength(1);
      expect(userSelfLogs[0]?.aggregateContext).toEqual({ source: 'root', rootOnly: true });
    });

    it('should pass aggregateIds aligned with the written rows to to() projection enrichers', async () => {
      const receivedCalls: { rows: Record<string, unknown>[]; aggregateIds: string[] }[] = [];

      const customEntities: EntityMap = {
        User: defineEntity({
          type: 'User',
          diffExcludeFields: ['updatedAt'],
        }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [
            to('User', foreignKey('authorId'), {
              aggregateContext: {
                enricher: async (rows, _prisma, meta) => {
                  receivedCalls.push({ rows, aggregateIds: meta.aggregateIds });
                  return rows.map((_row, i) => ({ authorIdFromMeta: meta.aggregateIds[i] }));
                },
              },
            }),
          ],
        }),
      };

      const {
        basePrisma: customBasePrisma,
        prisma: customPrisma,
        provider: customProvider,
      } = openClient({
        entities: customEntities,
      });

      const userA = await customBasePrisma.user.create({
        data: { email: 'align-a@example.com', name: 'Align A', password: 'pass' },
      });
      const userB = await customBasePrisma.user.create({
        data: { email: 'align-b@example.com', name: 'Align B', password: 'pass' },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'aligned-ids-actor' },
      };
      await customProvider.runAsync(actor, async () => {
        await customPrisma.post.createMany({
          data: [
            { title: 'Aligned 1', content: 'Content', authorId: userA.id },
            { title: 'Aligned 2', content: 'Content', authorId: userB.id },
            { title: 'Aligned 3', content: 'Content', authorId: userA.id },
          ],
        });
      });

      // One batched call per aggregateType; aggregateIds[i] corresponds to rows[i]
      expect(receivedCalls).toHaveLength(1);
      const call = receivedCalls[0];
      if (!call) throw new Error('Projection enricher was not called');
      expect(call.rows).toHaveLength(3);
      expect(call.aggregateIds).toHaveLength(call.rows.length);
      for (let i = 0; i < call.rows.length; i++) {
        expect(call.aggregateIds[i]).toBe(call.rows[i]?.authorId);
      }

      // Each stored log's aggregateContext matches its own aggregateId
      const postUserLogs = await customBasePrisma.auditLog.findMany({
        where: { entityType: 'Post', aggregateType: 'User', action: 'create', actorId: 'aligned-ids-actor' },
      });
      expect(postUserLogs).toHaveLength(3);
      for (const log of postUserLogs) {
        const aggregateContext = log.aggregateContext as Record<string, unknown>;
        expect(aggregateContext.authorIdFromMeta).toBe(log.aggregateId);
      }
    });

    it('should call the root-side aggregateContext enricher once per aggregate type with the unique aggregate ids', async () => {
      const receivedIds: string[][] = [];
      const {
        basePrisma,
        prisma: customPrisma,
        provider,
      } = openClient({
        entities: {
          User: defineEntity({
            type: 'User',
            diffExcludeFields: ['updatedAt'],
            aggregateContext: {
              enricher: async (userIds, _prisma) => {
                receivedIds.push([...userIds]);
                return userIds.map((id) => ({ rootUserId: id }));
              },
            },
          }),
          Post: defineEntity({
            type: 'Post',
            aggregates: [to('User', foreignKey('authorId'))],
          }),
        },
      });

      const userA = await basePrisma.user.create({
        data: { email: 'root-ids-a@example.com', name: 'Root Ids A', password: 'pass' },
      });
      const userB = await basePrisma.user.create({
        data: { email: 'root-ids-b@example.com', name: 'Root Ids B', password: 'pass' },
      });

      const actor: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'root-ids-actor' },
      };
      await provider.runAsync(actor, async () => {
        await customPrisma.post.createMany({
          data: [
            { title: 'Root Ids 1', content: 'Content', authorId: userA.id },
            { title: 'Root Ids 2', content: 'Content', authorId: userB.id },
            { title: 'Root Ids 3', content: 'Content', authorId: userA.id },
          ],
        });
      });

      // Three posts project onto two users: one call, each user id once
      expect(receivedIds).toHaveLength(1);
      expect([...(receivedIds[0] ?? [])].sort()).toEqual([userA.id, userB.id].sort());

      const userLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'Post', aggregateType: 'User', action: 'create' },
      });
      expect(userLogs).toHaveLength(3);
      for (const log of userLogs) {
        expect(log.aggregateContext).toEqual({ rootUserId: log.aggregateId });
      }
    });
  });
});
