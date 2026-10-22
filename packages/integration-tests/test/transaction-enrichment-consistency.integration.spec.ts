/**
 * Integration Tests: Transaction Enrichment Consistency
 *
 * Verifies enrichment functions receive the transactional client within $transaction blocks
 * and can read uncommitted changes.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it } from 'vitest';
import { setupTestContext } from './helpers/setup.js';

describe('Transaction Enrichment Consistency', () => {
  const context = setupTestContext();

  describe('Entity enricher should read uncommitted changes within transaction', () => {
    it('should allow entity enricher to read uncommitted UPDATE within $transaction', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedEmail: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: {
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
        write: {
          awaited: true,
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
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { email: 'new@example.com' },
          });
        });
      });

      expect(enrichedEmail).toBe('new@example.com');

      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]?.entityContext).toEqual({ enrichedEmail: 'new@example.com' });
    });

    it('should allow entity enricher to read uncommitted CREATE within $transaction', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedName: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: {
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
        write: {
          awaited: true,
        },
      });

      const user = await context.basePrisma.user.create({
        data: { email: 'author@example.com', name: 'Author', password: 'secret' },
      });

      const auditContext: AuditContext = {
        actor: { category: 'user', type: 'User', id: user.id },
      };

      await provider.runAsync(auditContext, async () => {
        await prisma.$transaction(async (tx) => {
          await tx.post.create({
            data: {
              title: 'New Post Title',
              content: 'Content',
              published: true,
              authorId: user.id,
            },
          });
        });
      });

      expect(enrichedName).toBe('New Post Title');

      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'create' },
        orderBy: { aggregateType: 'asc' },
      });

      expect(auditLogs.map((log) => [log.aggregateType, log.entityContext])).toEqual([
        ['Post', { enrichedTitle: 'New Post Title' }],
        ['User', { enrichedTitle: 'New Post Title' }],
      ]);
    });
  });

  describe('Aggregate enricher should read uncommitted changes within transaction', () => {
    type PostWithAuthor = { authorId: string };
    type UserFindManyClient = {
      user: {
        findMany: (args: {
          where: { id: { in: string[] } };
          select: { id: boolean; email: boolean };
        }) => Promise<{ id: string; email: string }[]>;
      };
    };

    const extractAuthorIds = (posts: PostWithAuthor[]): string[] => {
      const authorIds = new Set<string>();
      for (const post of posts) {
        if (post.authorId) {
          authorIds.add(post.authorId);
        }
      }
      return Array.from(authorIds);
    };

    const fetchUserEmailMap = async (prismaClient: unknown, authorIds: string[]): Promise<Map<string, string>> => {
      const userMap = new Map<string, string>();
      if (authorIds.length === 0) return userMap;

      const users = await (prismaClient as UserFindManyClient).user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, email: true },
      });

      for (const user of users) {
        userMap.set(user.id, user.email);
      }
      return userMap;
    };

    it('should allow aggregate enricher to read uncommitted changes in parent entity', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedUserEmail: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: {
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to('User', foreignKey('authorId'), {
                aggregateContext: {
                  enricher: async (rows, prismaClient: unknown) => {
                    const posts = rows as PostWithAuthor[];
                    const authorIds = extractAuthorIds(posts);
                    const userMap = await fetchUserEmailMap(prismaClient, authorIds);

                    // Store the first user's email for verification
                    const firstPost = posts[0];
                    if (firstPost) {
                      enrichedUserEmail = userMap.get(firstPost.authorId);
                    }

                    return posts.map((post) => ({
                      parentUserEmail: userMap.get(post.authorId) ?? null,
                    }));
                  },
                },
              }),
            ],
          }),
          User: defineEntity({ type: 'User' }),
        },
        write: {
          awaited: true,
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
        where: { entityType: 'Post', entityId: post.id, action: 'update', aggregateType: 'User' },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({ aggregateContext: { parentUserEmail: 'new-author@example.com' } });
    });
  });

  describe('Actor enricher should read uncommitted changes within transaction', () => {
    it('should allow actor enricher to read uncommitted changes in actor entity', async () => {
      const provider = createAsyncLocalStorageProvider();
      let enrichedActorName: string | undefined;

      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: {
          Post: defineEntity({
            type: 'Post',
            aggregates: [to('User', foreignKey('authorId'))],
          }),
          User: defineEntity({ type: 'User' }),
        },
        actorContext: {
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
        write: {
          awaited: true,
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
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: {
          User: defineEntity({
            type: 'User',
            entityContext: {
              enricher: async (entities, prismaClient) => {
                const ids = entities.map((e) => (e as { id: string }).id);
                const users = await (prismaClient as typeof context.basePrisma).user.findMany({
                  where: { id: { in: ids } },
                  select: { id: true, email: true },
                });
                const emailById = new Map(users.map((u: { id: string; email: string }) => [u.id, u.email]));
                enrichedEmails.push(...users.map((u: { email: string }) => u.email));
                return ids.map((id) => ({ enrichedEmail: emailById.get(id) }));
              },
            },
          }),
        },
        write: {
          awaited: true,
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

      expect([...enrichedEmails].sort()).toEqual(['user1@example.com', 'user2@example.com', 'user3@example.com']);

      const users = await context.basePrisma.user.findMany({ select: { id: true, email: true } });
      const auditLogs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } });
      expect(auditLogs).toHaveLength(3);
      expect(auditLogs.map((log) => [log.entityId, log.entityContext]).sort()).toEqual(
        users.map((user) => [user.id, { enrichedEmail: user.email }]).sort(),
      );
    });
  });
});
