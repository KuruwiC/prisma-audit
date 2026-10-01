/**
 * Integration Test: a nested to-many pre-fetch reads only rows under the parent row
 *
 * A nested `upsert` / `update` on a to-many relation names its target by a unique WHERE, but
 * Prisma applies it only to a row related to the parent. The before-state read must carry the
 * same scope: a row of another parent that matches the WHERE is not the target, so the upsert
 * runs its `create` branch and every write nested in that branch is audited.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-to-many-scope-actor' },
};

describe('nested to-many pre-fetch — parent row scope', () => {
  let sharedDatabaseUrl: string;
  let basePrisma: PrismaClient;
  let prisma: ReturnType<typeof createAuditClient<PrismaClient>>;
  let provider: ReturnType<typeof createAsyncLocalStorageProvider>;
  let observer: ReturnType<typeof vi.fn<AuditErrorObserver>>;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  beforeEach(() => {
    basePrisma = new PrismaClient({ datasources: { db: { url: sharedDatabaseUrl } } });
    provider = createAsyncLocalStorageProvider();
    observer = vi.fn<AuditErrorObserver>();
    prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      performance: { awaitWrite: true },
      fetchBefore: {
        update: true,
        delete: true,
      },
      errorHandling: { observer },
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  });

  const seedUsers = async (label: string) => {
    const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userA = await basePrisma.user.create({
      data: { email: `scope-a-${suffix}@example.com`, name: 'A', password: 'secret123' },
    });
    const userB = await basePrisma.user.create({
      data: { email: `scope-b-${suffix}@example.com`, name: 'B', password: 'secret123' },
    });
    const postB = await basePrisma.post.create({
      data: { title: 'B post', content: 'owned by B', authorId: userB.id },
    });
    return { suffix, userA, userB, postB };
  };

  const upsertPostWithCommentUnder = (userId: string, postWhereId: string) =>
    provider.runAsync(testActor, async () =>
      prisma.user.update({
        where: { id: userId },
        data: {
          posts: {
            upsert: {
              where: { id: postWhereId },
              create: {
                title: 'new',
                comments: { create: { content: 'c', authorId: userId } },
              },
              update: { title: 'hijack' },
            },
          },
        },
      }),
    );

  const logsFor = (entityType: string, entityIds: string[]) =>
    basePrisma.auditLog.findMany({
      where: { entityType, entityId: { in: entityIds } },
      select: { action: true, entityId: true, aggregateType: true, aggregateId: true },
      orderBy: [{ action: 'asc' }, { aggregateType: 'asc' }],
    });

  const expectCreateLogsForNewPostAndComment = async (userId: string, untouchedPostIds: string[]) => {
    const newPosts = await basePrisma.post.findMany({ where: { authorId: userId }, include: { comments: true } });
    expect(newPosts).toHaveLength(1);
    const [newPost] = newPosts;
    expect(newPost?.title).toBe('new');
    expect(newPost?.comments).toHaveLength(1);
    const newComment = newPost?.comments[0];

    expect(await logsFor('Post', [newPost?.id ?? '', ...untouchedPostIds])).toEqual([
      { action: 'create', entityId: newPost?.id, aggregateType: 'Post', aggregateId: newPost?.id },
      { action: 'create', entityId: newPost?.id, aggregateType: 'User', aggregateId: userId },
    ]);

    expect(await logsFor('Comment', [newComment?.id ?? ''])).toEqual([
      { action: 'create', entityId: newComment?.id, aggregateType: 'Comment', aggregateId: newComment?.id },
      { action: 'create', entityId: newComment?.id, aggregateType: 'Post', aggregateId: newPost?.id },
      { action: 'create', entityId: newComment?.id, aggregateType: 'User', aggregateId: userId },
    ]);
  };

  it("an upsert whose WHERE names another parent's row creates a new row and audits the writes nested in its create branch", async () => {
    const { userA, postB } = await seedUsers('other-parent');

    await upsertPostWithCommentUnder(userA.id, postB.id);

    await expectCreateLogsForNewPostAndComment(userA.id, [postB.id]);
    expect((await basePrisma.post.findUnique({ where: { id: postB.id } }))?.title).toBe('B post');
    expect(observer).not.toHaveBeenCalled();
  });

  it('an upsert whose WHERE names no row creates a new row and audits the writes nested in its create branch', async () => {
    const { suffix, userA } = await seedUsers('missing');

    await upsertPostWithCommentUnder(userA.id, `missing-${suffix}`);

    await expectCreateLogsForNewPostAndComment(userA.id, []);
    expect(observer).not.toHaveBeenCalled();
  });

  it("an update whose WHERE names another parent's row is rejected by Prisma and writes no audit log", async () => {
    const { userA, postB } = await seedUsers('update-other-parent');

    await expect(
      provider.runAsync(testActor, async () =>
        prisma.user.update({
          where: { id: userA.id },
          data: { posts: { update: { where: { id: postB.id }, data: { title: 'x' } } } },
        }),
      ),
    ).rejects.toThrow();

    expect((await basePrisma.post.findUnique({ where: { id: postB.id } }))?.title).toBe('B post');
    expect(await logsFor('Post', [postB.id])).toEqual([]);
    expect(await basePrisma.auditLog.count({ where: { entityType: 'User', entityId: userA.id } })).toBe(0);
    expect(observer).not.toHaveBeenCalled();
  });
});
