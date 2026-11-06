/**
 * Integration Test: a nested upsert or connectOrCreate whose target could not be read
 *
 * Whether a nested upsert updated or created its row, and whether a connectOrCreate connected or
 * created it, is what the pre-fetch of its target tells. When that read fails, the caller's write
 * still succeeds and the failure reaches the observer as a `pre-fetch` failure, but the row gets no
 * audit entry, as for a top-level upsert whose before-state read failed: recording it would mean
 * guessing its action.
 *
 * The reads are failed with a Prisma Client Extension applied before the audit extension: the
 * to-many pre-fetch reads with `comment.findUnique`, the to-one pre-fetch with
 * `profile.findFirst`. Prisma's own nested-write execution does not call those JS-level methods.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
import { createReadFault } from './helpers/read-fault.js';
import { cleanDatabase, createBasePrisma, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-upsert-pre-fetch-actor' },
};

const FAILURE_MESSAGE = 'simulated nested pre-fetch failure';

describe('nested upsert and connectOrCreate whose target could not be read', () => {
  const createClient = () => {
    const rawBasePrisma = createBasePrisma();

    const fault = createReadFault();
    const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: fault.query });
    const arm = {
      commentFindUnique: () => fault.arm({ model: 'Comment', operation: 'findUnique' }, FAILURE_MESSAGE),
      profileFindFirst: () => fault.arm({ model: 'Profile', operation: 'findFirst' }, FAILURE_MESSAGE),
    };

    const observer = vi.fn<AuditObserver>();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      diffExcludeFields: ['createdAt', 'updatedAt'],
      observer,
      // Under the awaited mode a dropped entry is only reported; an atomic write would fail instead
      write: { mode: 'awaited' },
    });

    return { rawBasePrisma, basePrisma, provider, prisma, observer, arm };
  };

  let scenario: ReturnType<typeof createClient> | undefined;

  const setUp = async () => {
    scenario = createClient();
    const { rawBasePrisma, basePrisma } = scenario;
    await cleanDatabase(rawBasePrisma);
    const user = await basePrisma.user.create({
      data: { email: 'nested-upsert-pre-fetch@example.com', name: 'Owner', password: 'secret123' },
    });
    const post = await basePrisma.post.create({ data: { title: 'Post', content: 'content', authorId: user.id } });
    const comment = await basePrisma.comment.create({
      data: { content: 'Original', postId: post.id, authorId: user.id },
    });
    return { ...scenario, user, post, comment };
  };

  afterEach(async () => {
    await scenario?.prisma.$disconnect();
    await scenario?.rawBasePrisma.$disconnect();
    scenario = undefined;
  });

  const expectPreFetchFailureReported = (observer: ReturnType<typeof vi.fn<AuditObserver>>) => {
    expect(failuresOf(observer)).toContainEqual(
      expect.objectContaining({ phase: 'pre-fetch', error: expect.objectContaining({ message: FAILURE_MESSAGE }) }),
    );
  };

  it('records no entry for a to-many upsert that updated a row it could not read', async () => {
    const { basePrisma, provider, prisma, observer, arm, post, comment } = await setUp();

    arm.commentFindUnique();
    await provider.runAsync(testActor, () =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          comments: {
            upsert: {
              where: { id: comment.id },
              create: { content: 'Created', authorId: post.authorId },
              update: { content: 'Updated' },
            },
          },
        },
      }),
    );

    expect((await basePrisma.comment.findUnique({ where: { id: comment.id } }))?.content).toBe('Updated');
    expectPreFetchFailureReported(observer);
    expect(await basePrisma.auditLog.findMany({ where: { entityType: 'Comment' } })).toEqual([]);
  });

  it('records no entry for a connectOrCreate that connected a row it could not read', async () => {
    const { basePrisma, provider, prisma, observer, arm, user, comment } = await setUp();
    const otherPost = await basePrisma.post.create({ data: { title: 'Other', content: 'other', authorId: user.id } });

    arm.commentFindUnique();
    await provider.runAsync(testActor, () =>
      prisma.post.update({
        where: { id: otherPost.id },
        data: {
          comments: {
            connectOrCreate: { where: { id: comment.id }, create: { content: 'Created', authorId: user.id } },
          },
        },
      }),
    );

    expect((await basePrisma.comment.findUnique({ where: { id: comment.id } }))?.postId).toBe(otherPost.id);
    expectPreFetchFailureReported(observer);
    expect(await basePrisma.auditLog.findMany({ where: { entityType: 'Comment' } })).toEqual([]);
  });

  it('records no entry for a to-one upsert that updated a row it could not read', async () => {
    const { basePrisma, provider, prisma, observer, arm, user } = await setUp();
    await basePrisma.profile.create({ data: { userId: user.id, bio: 'Original' } });

    arm.profileFindFirst();
    await provider.runAsync(testActor, () =>
      prisma.user.update({
        where: { id: user.id },
        data: { profile: { upsert: { create: { bio: 'Created' }, update: { bio: 'Updated' } } } },
      }),
    );

    expect((await basePrisma.profile.findUnique({ where: { userId: user.id } }))?.bio).toBe('Updated');
    expectPreFetchFailureReported(observer);
    expect(await basePrisma.auditLog.findMany({ where: { entityType: 'Profile' } })).toEqual([]);
  });
});
