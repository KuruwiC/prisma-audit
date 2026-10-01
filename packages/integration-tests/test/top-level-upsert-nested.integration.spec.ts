/**
 * A top-level upsert audits only the nested writes of the branch its before-state fetch identifies
 * (existing row → `update`, missing row → `create`), whether or not nested records were pre-fetched.
 * When that fetch fails the branch is unknown, so the nested entries are skipped with the main entry.
 * The before-state fetch is a `post.findUnique` through the base client, which is how the
 * `fault-injection` query extension fails it.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver, PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'top-level-upsert-nested-actor' },
};

const FAILURE_MESSAGE = 'simulated before-state fetch failure';

type FetchBeforeConfig = NonNullable<PrismaAuditExtensionOptions['fetchBefore']>;

const createClients = (databaseUrl: string, fetchBefore: FetchBeforeConfig) => {
  const rawBasePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  let failNextPostFindUnique = false;
  const basePrisma = rawBasePrisma.$extends({
    name: 'fault-injection',
    query: {
      post: {
        async findUnique({ args, query }) {
          if (failNextPostFindUnique) {
            failNextPostFindUnique = false;
            throw new Error(FAILURE_MESSAGE);
          }
          return query(args);
        },
      },
    },
  });

  const observer = vi.fn<AuditErrorObserver>();
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
    diffing: { excludeFields: ['createdAt'] },
    security: { redact: { fields: [] } },
    performance: { awaitWrite: true },
    fetchBefore,
    errorHandling: { observer },
  });

  return {
    rawBasePrisma,
    basePrisma,
    prisma,
    observer,
    asActor: <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn),
    armPostFindUniqueFailure: () => {
      failNextPostFindUnique = true;
    },
  };
};

describe('top-level upsert nested audit entries', () => {
  let databaseUrl: string;
  let clients: ReturnType<typeof createClients> | undefined;

  const setUp = async (fetchBefore: FetchBeforeConfig) => {
    clients = createClients(databaseUrl, fetchBefore);
    await cleanDatabase(clients.rawBasePrisma);
    return clients;
  };

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    await clients?.prisma.$disconnect();
    await clients?.rawBasePrisma.$disconnect();
    clients = undefined;
  });

  it('audits the nested creates of the create branch when the upsert creates the row', async () => {
    const { basePrisma, prisma, asActor } = await setUp({
      update: true,
      delete: true,
    });
    const author = await basePrisma.user.create({
      data: { email: 'upsert-create-author@example.com', name: 'Author', password: 'secret123' },
    });

    const post = await asActor(() =>
      prisma.post.upsert({
        where: { id: 'post-that-does-not-exist' },
        create: {
          title: 'Created Through Upsert',
          authorId: author.id,
          postTags: {
            create: [
              {
                tag: {
                  connectOrCreate: {
                    where: { name: 'upsert-created-tag' },
                    create: { name: 'upsert-created-tag' },
                  },
                },
              },
            ],
          },
        },
        update: { title: 'Updated Through Upsert' },
        include: { postTags: { include: { tag: true } } },
      }),
    );

    const postTag = post.postTags[0];
    expect(postTag).toBeDefined();

    const postTagLogs = await basePrisma.auditLog.findMany({ where: { entityType: 'PostTag', entityId: postTag?.id } });
    expect(postTagLogs.map((log) => log.action)).toContain('create');

    const tagLogs = await basePrisma.auditLog.findMany({ where: { entityType: 'Tag', entityId: postTag?.tag.id } });
    expect(tagLogs.map((log) => log.action)).toContain('create');
  });

  it('records the nested write of the update branch as update when the upsert updates the row', async () => {
    const { basePrisma, prisma, asActor } = await setUp({ update: false });
    const user = await basePrisma.user.create({
      data: {
        email: 'upsert-update-user@example.com',
        name: 'User',
        password: 'secret123',
        profile: { create: { bio: 'Original bio' } },
      },
      include: { profile: true },
    });

    await asActor(() =>
      prisma.user.upsert({
        where: { id: user.id },
        create: { email: 'never-created@example.com', profile: { create: { bio: 'Created bio' } } },
        update: { profile: { update: { bio: 'Updated bio' } } },
        include: { profile: true },
      }),
    );

    const profileLogs = await basePrisma.auditLog.findMany({
      where: { entityType: 'Profile', entityId: user.profile?.id },
    });
    expect(profileLogs.length).toBeGreaterThan(0);
    expect([...new Set(profileLogs.map((log) => log.action))]).toEqual(['update']);
  });

  it('skips the nested entries of an upsert whose before-state fetch failed, and the caller still succeeds', async () => {
    const { basePrisma, prisma, asActor, observer, armPostFindUniqueFailure } = await setUp({
      update: true,
      delete: true,
    });
    const author = await basePrisma.user.create({
      data: { email: 'upsert-failure-author@example.com', name: 'Author', password: 'secret123' },
    });
    const existingPost = await basePrisma.post.create({ data: { title: 'Original Title', authorId: author.id } });

    armPostFindUniqueFailure();
    const upserted = await asActor(() =>
      prisma.post.upsert({
        where: { id: existingPost.id },
        create: { title: 'Should never be used', authorId: author.id },
        update: {
          title: 'Updated Through Upsert',
          postTags: {
            create: [
              {
                tag: {
                  connectOrCreate: {
                    where: { name: 'upsert-failure-tag' },
                    create: { name: 'upsert-failure-tag' },
                  },
                },
              },
            ],
          },
        },
        include: { postTags: { include: { tag: true } } },
      }),
    );

    expect(upserted.id).toBe(existingPost.id);
    expect(upserted.postTags).toHaveLength(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'pre-fetch',
        modelName: 'Post',
        error: expect.objectContaining({ message: FAILURE_MESSAGE }),
      }),
    );

    const logs = await basePrisma.auditLog.findMany();
    expect(logs.map((log) => `${log.entityType}:${log.action}`)).toEqual([]);
  });
});
