/**
 * Integration Tests: Transaction Enrichment Consistency
 *
 * Verifies enrichment functions receive the transactional client within $transaction blocks
 * and can read uncommitted changes.
 */

import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Transaction Enrichment Consistency', () => {
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

  describe('Entity enricher should read uncommitted changes within transaction', () => {
    it('should allow entity enricher to read uncommitted UPDATE within $transaction', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedEmail: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider,
        basePrisma: context.basePrisma,
        aggregateMapping: {
          User: defineEntity({
            type: 'User',
            entityContext: {
              enricher: async (entities, prismaClient) => {
                const user = await (prismaClient as typeof context.basePrisma).user.findUnique({
                  where: { id: (entities[0] as { id: string }).id },
                  select: { email: true },
                });
                enrichedEmail = user?.email;
                return entities.map(() => ({ enrichedEmail: user?.email }));
              },
            },
          }),
        },
        performance: {
          awaitWrite: true,
        },
      });

      const user = await context.basePrisma.user.create({
        data: {
          email: 'old@example.com',
          name: 'Test User',
          password: 'secret',
        },
      });

      const auditContext: AuditContext = {
        actor: { category: 'user', type: 'User', id: 'actor-1' },
      };

      await provider.runAsync(auditContext, async () => {
        await prisma.user.update({
          where: { id: user.id },
          data: { email: 'new@example.com' },
        });
      });

      expect(enrichedEmail).toBe('new@example.com');

      const auditLog = await context.basePrisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.entityContext).toBeDefined();
      const entityContext = auditLog?.entityContext as Record<string, unknown>;
      expect(entityContext.enrichedEmail).toBe('new@example.com');
    });

    it('should allow entity enricher to read uncommitted CREATE within $transaction', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedName: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider,
        basePrisma: context.basePrisma,
        aggregateMapping: {
          Post: defineEntity({
            type: 'Post',
            aggregates: [to('User', foreignKey('authorId'))],
            entityContext: {
              enricher: async (entities, prismaClient) => {
                const post = await (prismaClient as typeof context.basePrisma).post.findUnique({
                  where: { id: (entities[0] as { id: string }).id },
                  select: { title: true },
                });
                enrichedName = post?.title;
                return entities.map(() => ({ enrichedTitle: post?.title }));
              },
            },
          }),
          User: defineEntity({ type: 'User' }),
        },
        performance: {
          awaitWrite: true,
        },
      });

      const user = await context.basePrisma.user.create({
        data: { email: 'author@example.com', name: 'Author', password: 'secret' },
      });

      const auditContext: AuditContext = {
        actor: { category: 'user', type: 'User', id: user.id },
      };

      await provider.runAsync(auditContext, async () => {
        await prisma.post.create({
          data: {
            title: 'New Post Title',
            content: 'Content',
            published: true,
            authorId: user.id,
          },
        });
      });

      expect(enrichedName).toBe('New Post Title');
    });
  });

  describe('Aggregate enricher should read uncommitted changes within transaction', () => {
    it('should allow aggregate enricher to read uncommitted changes in parent entity', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedUserEmail: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider,
        basePrisma: context.basePrisma,
        aggregateMapping: {
          Post: defineEntity({
            type: 'Post',
            aggregates: [to('User', foreignKey('authorId'))],
            aggregateContextMap: {
              User: {
                enricher: async (aggregates: unknown[], prismaClient: unknown) => {
                  // First parameter is the aggregate root entities (User in this case), not the current entity (Post)
                  const post = aggregates[0] as { authorId: string };
                  const user = await (
                    prismaClient as unknown as {
                      user: {
                        findUnique: (args: {
                          where: { id: string };
                          select: { email: boolean };
                        }) => Promise<{ email: string } | null>;
                      };
                    }
                  ).user.findUnique({
                    where: { id: post.authorId },
                    select: { email: true },
                  });
                  enrichedUserEmail = user?.email;
                  return aggregates.map(() => ({ parentUserEmail: user?.email }));
                },
              },
            },
          }),
          User: defineEntity({ type: 'User' }),
        },
        performance: {
          awaitWrite: true,
        },
      });

      const user = await context.basePrisma.user.create({
        data: { email: 'old-author@example.com', name: 'Author', password: 'secret' },
      });

      const post = await context.basePrisma.post.create({
        data: {
          title: 'Test Post',
          content: 'Content',
          published: true,
          authorId: user.id,
        },
      });

      const auditContext: AuditContext = {
        actor: { category: 'user', type: 'User', id: 'actor-1' },
      };

      await provider.runAsync(auditContext, async () => {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { email: 'new-author@example.com' },
          });

          await tx.post.update({
            where: { id: post.id },
            data: { title: 'Updated Post Title' },
          });
        });
      });

      expect(enrichedUserEmail).toBe('new-author@example.com');

      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, action: 'update' },
        orderBy: { createdAt: 'desc' },
      });

      expect(auditLogs.length).toBeGreaterThan(0);
      const auditLog = auditLogs[0];
      expect(auditLog).toBeDefined();

      if (auditLog?.aggregateContext) {
        const aggregateContext = auditLog.aggregateContext as Record<string, unknown>;
        expect(aggregateContext.parentUserEmail).toBe('new-author@example.com');
      } else {
        throw new Error(`aggregateContext is null. Full log: ${JSON.stringify(auditLog, null, 2)}`);
      }
    });
  });

  describe('Actor enricher should read uncommitted changes within transaction', () => {
    it('should allow actor enricher to read uncommitted changes in actor entity', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedActorName: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider,
        basePrisma: context.basePrisma,
        aggregateMapping: {
          Post: defineEntity({
            type: 'Post',
            aggregates: [to('User', foreignKey('authorId'))],
          }),
          User: defineEntity({ type: 'User' }),
        },
        contextEnricher: {
          actor: {
            enricher: async (actor, prismaClient) => {
              const actorData = actor as { category: string; type: string; id: string };
              if (actorData.category === 'model' && actorData.type === 'User') {
                const user = await (
                  prismaClient as unknown as {
                    user: {
                      findUnique: (args: {
                        where: { id: string };
                        select: { name: boolean; email: boolean };
                      }) => Promise<{ name: string; email: string } | null>;
                    };
                  }
                ).user.findUnique({
                  where: { id: actorData.id },
                  select: { name: true, email: true },
                });
                enrichedActorName = user?.name ?? undefined;
                return { userName: user?.name ?? undefined, userEmail: user?.email ?? undefined };
              }
              return null;
            },
            onError: 'log',
            fallback: null,
          },
        },
        performance: {
          awaitWrite: true,
        },
      });

      const actorUser = await context.basePrisma.user.create({
        data: { email: 'actor@example.com', name: 'Old Actor Name', password: 'secret' },
      });

      const auditContext: AuditContext = {
        actor: { category: 'model', type: 'User', id: actorUser.id },
      };

      await provider.runAsync(auditContext, async () => {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: actorUser.id },
            data: { name: 'New Actor Name' },
          });

          await tx.post.create({
            data: {
              title: 'Post by Updated Actor',
              content: 'Content',
              published: true,
              authorId: actorUser.id,
            },
          });
        });
      });

      expect(enrichedActorName).toBe('New Actor Name');

      const auditLog = await context.basePrisma.auditLog.findFirst({
        where: { entityType: 'Post', action: 'create' },
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.actorContext).toBeDefined();
      const actorContext = auditLog?.actorContext as Record<string, unknown>;
      expect(actorContext.userName).toBe('New Actor Name');
    });
  });

  describe('Batch enrichment within transaction', () => {
    it('should allow batch entity enricher to read all uncommitted creates', async () => {
      const provider = createAsyncLocalStorageProvider();
      const enrichedEmails: string[] = [];

      const prisma = createAuditClient(context.basePrisma, {
        DbNull: Prisma.DbNull,
        provider,
        basePrisma: context.basePrisma,
        aggregateMapping: {
          User: defineEntity({
            type: 'User',
            entityContext: {
              enricher: async (entities, prismaClient) => {
                const ids = entities.map((e) => (e as { id: string }).id);
                const users = await (prismaClient as typeof context.basePrisma).user.findMany({
                  where: { id: { in: ids } },
                  select: { id: true, email: true },
                  orderBy: { email: 'asc' },
                });
                enrichedEmails.push(...users.map((u: { email: string }) => u.email));
                return users.map((u: { email: string }) => ({ enrichedEmail: u.email }));
              },
            },
          }),
        },
        performance: {
          awaitWrite: true,
        },
      });

      const auditContext: AuditContext = {
        actor: { category: 'system', type: 'System', id: 'system' },
      };

      await provider.runAsync(auditContext, async () => {
        await prisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1', password: 'secret' },
            { email: 'user2@example.com', name: 'User 2', password: 'secret' },
            { email: 'user3@example.com', name: 'User 3', password: 'secret' },
          ],
        });
      });

      expect(enrichedEmails).toHaveLength(3);
      expect(enrichedEmails).toContain('user1@example.com');
      expect(enrichedEmails).toContain('user2@example.com');
      expect(enrichedEmails).toContain('user3@example.com');
    });
  });
});
