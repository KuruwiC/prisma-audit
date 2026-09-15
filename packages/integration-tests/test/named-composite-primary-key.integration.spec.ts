/**
 * `PostBookmark` declares `@@id([postId, userId], name: "bookmarkKey")`, so Prisma addresses a row
 * as `{ bookmarkKey: { postId, userId } }` instead of the default `{ postId_userId: { ... } }`, and
 * every path that reads a compound-unique WHERE clause must unwrap it under the declared name.
 */

import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AggregateMapping, AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'named-composite-pk-actor' },
};

const compositeEntityId = (postId: string, userId: string): string => JSON.stringify([postId, userId]);

type Scenario = {
  basePrisma: PrismaClient;
  prisma: ReturnType<typeof createAuditClient>;
  provider: ReturnType<typeof createAsyncLocalStorageProvider>;
  observer: ReturnType<typeof vi.fn<AuditErrorObserver>>;
};

describe('Named Composite Primary Key (PostBookmark)', () => {
  let databaseUrl: string;
  let cleanupPrisma: PrismaClient;
  const openScenarios: Scenario[] = [];

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
    cleanupPrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterAll(async () => {
    await cleanupPrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(cleanupPrisma);
  });

  afterEach(async () => {
    for (const scenario of openScenarios.splice(0)) {
      await scenario.prisma.$disconnect();
      await scenario.basePrisma.$disconnect();
    }
  });

  const createScenario = (options: { fetchBeforeDelete: boolean }): Scenario => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const provider = createAsyncLocalStorageProvider();
    const observer = vi.fn<AuditErrorObserver>();
    const aggregateMapping: AggregateMapping = options.fetchBeforeDelete
      ? testAggregateMapping
      : {
          ...testAggregateMapping,
          PostBookmark: defineEntity({
            type: 'PostBookmark',
            idResolver: async (entity) => {
              const record = entity as { postId: string; userId: string };
              return JSON.stringify([record.postId, record.userId]);
            },
            aggregates: [to('Post', foreignKey('postId'))],
            nestedOperations: { delete: { fetchBeforeOperation: false } },
          }),
        };
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      performance: { awaitWrite: true },
      ...(options.fetchBeforeDelete ? {} : { nestedOperations: { delete: { fetchBeforeOperation: false } } }),
      errorHandling: { observer },
    });
    const scenario = { basePrisma, prisma, provider, observer };
    openScenarios.push(scenario);
    return scenario;
  };

  const createUserAndPost = async (basePrisma: PrismaClient) => {
    const user = await basePrisma.user.create({
      data: { email: 'bookmarker@example.com', name: 'Bookmarker', password: 'secret123' },
    });
    const post = await basePrisma.post.create({
      data: { title: 'Bookmarkable Post', content: 'content', authorId: user.id },
    });
    return { user, post };
  };

  describe('nested delete via the named compound key', () => {
    it('records the real composite entityId and before state with the default configuration', async () => {
      const { basePrisma, prisma, provider, observer } = createScenario({ fetchBeforeDelete: true });
      const { user, post } = await createUserAndPost(basePrisma);
      await basePrisma.postBookmark.create({ data: { postId: post.id, userId: user.id, label: 'to-delete' } });

      await provider.runAsync(testActor, async () => {
        await prisma.post.update({
          where: { id: post.id },
          data: { postBookmarks: { delete: { bookmarkKey: { postId: post.id, userId: user.id } } } },
          include: { postBookmarks: true },
        });
      });

      const stillExists = await basePrisma.postBookmark.findUnique({
        where: { bookmarkKey: { postId: post.id, userId: user.id } },
      });
      expect(stillExists).toBeNull();

      const deleteLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'PostBookmark', entityId: compositeEntityId(post.id, user.id), action: 'delete' },
        orderBy: { aggregateType: 'asc' },
      });
      expect(deleteLogs.map((log) => log.aggregateType)).toEqual(['Post', 'PostBookmark']);
      expect(deleteLogs.find((log) => log.aggregateType === 'Post')?.aggregateId).toBe(post.id);
      for (const log of deleteLogs) {
        expect(log.before).toMatchObject({ postId: post.id, userId: user.id, label: 'to-delete' });
        expect(log.after).toBeNull();
      }
      expect(observer).not.toHaveBeenCalled();
    });

    it('records the real composite entityId from the WHERE clause alone when fetchBeforeOperation is false', async () => {
      const { basePrisma, prisma, provider, observer } = createScenario({ fetchBeforeDelete: false });
      const { user, post } = await createUserAndPost(basePrisma);
      await basePrisma.postBookmark.create({ data: { postId: post.id, userId: user.id, label: 'to-delete' } });

      await provider.runAsync(testActor, async () => {
        await prisma.post.update({
          where: { id: post.id },
          data: { postBookmarks: { delete: { bookmarkKey: { postId: post.id, userId: user.id } } } },
          include: { postBookmarks: true },
        });
      });

      const stillExists = await basePrisma.postBookmark.findUnique({
        where: { bookmarkKey: { postId: post.id, userId: user.id } },
      });
      expect(stillExists).toBeNull();

      const deleteLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'PostBookmark', entityId: compositeEntityId(post.id, user.id), action: 'delete' },
        orderBy: { aggregateType: 'asc' },
      });
      expect(deleteLogs.map((log) => log.aggregateType)).toEqual(['Post', 'PostBookmark']);
      expect(deleteLogs.find((log) => log.aggregateType === 'Post')?.aggregateId).toBe(post.id);
      for (const log of deleteLogs) {
        expect(log.before).toBeNull();
        expect(log.after).toBeNull();
      }
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe('nested connectOrCreate via the named compound key', () => {
    it('creates a new row and records the real composite entityId with action=create', async () => {
      const { basePrisma, prisma, provider, observer } = createScenario({ fetchBeforeDelete: true });
      const { user, post } = await createUserAndPost(basePrisma);

      await provider.runAsync(testActor, async () => {
        await prisma.post.update({
          where: { id: post.id },
          data: {
            postBookmarks: {
              connectOrCreate: {
                where: { bookmarkKey: { postId: post.id, userId: user.id } },
                create: { userId: user.id, label: 'connect-or-create-new' },
              },
            },
          },
          include: { postBookmarks: true },
        });
      });

      const createLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'PostBookmark', entityId: compositeEntityId(post.id, user.id), action: 'create' },
        orderBy: { aggregateType: 'asc' },
      });
      expect(createLogs.map((log) => log.aggregateType)).toEqual(['Post', 'PostBookmark']);
      for (const log of createLogs) {
        expect(log.before).toBeNull();
        expect(log.after).toMatchObject({ postId: post.id, userId: user.id, label: 'connect-or-create-new' });
      }
      expect(observer).not.toHaveBeenCalled();
    });

    it('connects an existing row without creating a duplicate or recording a create', async () => {
      const { basePrisma, prisma, provider, observer } = createScenario({ fetchBeforeDelete: true });
      const { user, post } = await createUserAndPost(basePrisma);
      await basePrisma.postBookmark.create({ data: { postId: post.id, userId: user.id, label: 'already-bookmarked' } });

      await provider.runAsync(testActor, async () => {
        await prisma.post.update({
          where: { id: post.id },
          data: {
            postBookmarks: {
              connectOrCreate: {
                where: { bookmarkKey: { postId: post.id, userId: user.id } },
                create: { userId: user.id, label: 'should-not-be-created' },
              },
            },
          },
          include: { postBookmarks: true },
        });
      });

      const bookmarks = await basePrisma.postBookmark.findMany({ where: { postId: post.id, userId: user.id } });
      expect(bookmarks.map((bookmark) => bookmark.label)).toEqual(['already-bookmarked']);

      const createLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'PostBookmark', action: 'create' },
      });
      expect(createLogs).toHaveLength(0);
      expect(observer).not.toHaveBeenCalled();
    });
  });
});
