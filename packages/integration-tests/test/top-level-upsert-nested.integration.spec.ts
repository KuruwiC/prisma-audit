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
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostReadFault } from './helpers/post-read-fault.js';
import { cleanDatabase, createBasePrisma, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'top-level-upsert-nested-actor' },
};

const FAILURE_MESSAGE = 'simulated before-state fetch failure';

type FetchBeforeConfig = NonNullable<PrismaAuditExtensionOptions['fetchBefore']>;

const createClients = (databaseUrl: string, fetchBefore: FetchBeforeConfig) => {
  const rawBasePrisma = createBasePrisma(databaseUrl);

  const { findUnique, armFindUniqueFailure } = createPostReadFault(FAILURE_MESSAGE);
  const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: { post: { findUnique } } });

  const observer = vi.fn<AuditErrorObserver>();
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
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
    armPostFindUniqueFailure: armFindUniqueFailure,
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

    expect(post.postTags).toHaveLength(1);
    const postTagId = post.postTags[0]?.id;
    const tagId = post.postTags[0]?.tag.id;

    const logs = await basePrisma.auditLog.findMany();
    expect(logs.map((log) => `${log.entityType}:${log.entityId}:${log.action}:${log.aggregateType}`).sort()).toEqual(
      [
        `Post:${post.id}:create:Post`,
        `Post:${post.id}:create:User`,
        `PostTag:${postTagId}:create:Post`,
        `PostTag:${postTagId}:create:PostTag`,
        `PostTag:${postTagId}:create:Tag`,
        `Tag:${tagId}:create:Tag`,
      ].sort(),
    );
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
    expect(upserted.title).toBe('Updated Through Upsert');
    expect(await basePrisma.post.count({ where: { authorId: author.id } })).toBe(1);
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

  describe('with the same keyword on the same relation in both branches', () => {
    const seed = async () => {
      const seeded = await setUp({ update: true, delete: true });
      await seeded.basePrisma.user.create({ data: { id: 'u1', email: 'ada@example.com', name: 'Ada' } });
      await seeded.basePrisma.user.create({ data: { id: 'u2', email: 'ben@example.com', name: 'Ben' } });
      await seeded.basePrisma.post.create({ data: { id: 'p-u2', title: 'Other', authorId: 'u2' } });
      /** One `entityId:action` per record of `entityType` (its own aggregate row), sorted */
      const recordsOf = async (entityType: string) =>
        (
          await seeded.basePrisma.auditLog.findMany({
            where: { entityType, aggregateType: entityType },
            select: { entityId: true, action: true },
          })
        )
          .map((log) => `${log.entityId}:${log.action}`)
          .sort();
      return { ...seeded, recordsOf };
    };

    it('audits the row the update branch connects as an update, not a create', async () => {
      const { basePrisma, prisma, asActor, recordsOf } = await seed();

      await asActor(() =>
        prisma.user.upsert({
          where: { id: 'u1' },
          create: {
            id: 'u1',
            email: 'never-created@example.com',
            posts: { connectOrCreate: { where: { id: 'p-none' }, create: { id: 'p-none', title: 'None' } } },
          },
          update: { posts: { connectOrCreate: { where: { id: 'p-u2' }, create: { id: 'p-u2', title: 'x' } } } },
        }),
      );

      expect(await recordsOf('Post')).toEqual(['p-u2:update']);
      const moved = await basePrisma.auditLog.findFirst({
        where: { entityType: 'Post', entityId: 'p-u2', aggregateType: 'Post' },
        select: { changes: true },
      });
      expect(moved?.changes).toMatchObject({ authorId: { old: 'u2', new: 'u1' } });
    });

    it('audits the rows written below the update branch copy of the relation', async () => {
      const { prisma, asActor, recordsOf } = await seed();

      await asActor(() =>
        prisma.user.upsert({
          where: { id: 'u1' },
          create: { id: 'u1', email: 'never-created@example.com', posts: { create: { id: 'p-c', title: 'c' } } },
          update: {
            posts: {
              create: { id: 'p-n', title: 'n', comments: { create: { id: 'k-n', content: 'n', authorId: 'u1' } } },
            },
          },
        }),
      );

      expect(await recordsOf('Post')).toEqual(['p-n:create']);
      expect(await recordsOf('Comment')).toEqual(['k-n:create']);
    });

    it('audits the rows written below the create branch copy of the relation', async () => {
      const { prisma, asActor, recordsOf } = await seed();

      await asActor(() =>
        prisma.user.upsert({
          where: { id: 'u-new' },
          create: {
            id: 'u-new',
            email: 'new@example.com',
            posts: {
              create: { id: 'p-c', title: 'c', comments: { create: { id: 'k-c', content: 'c', authorId: 'u1' } } },
            },
          },
          update: { posts: { create: { id: 'p-n', title: 'n' } } },
        }),
      );

      expect(await recordsOf('Post')).toEqual(['p-c:create']);
      expect(await recordsOf('Comment')).toEqual(['k-c:create']);
    });
  });
});
