/**
 * Integration Test: a nested upsert or connectOrCreate whose target could not be read
 *
 * Whether a nested upsert updated or created its row, and whether a connectOrCreate connected or
 * created it, is what the pre-fetch of its target tells. When that read fails, the caller's write
 * still succeeds and the failure reaches the observer under `pre-fetch`, but the row gets no
 * audit entry, as for a top-level upsert whose before-state read failed: recording it would mean
 * guessing its action.
 *
 * The reads are failed with a Prisma Client Extension applied before the audit extension: the
 * to-many pre-fetch reads with `comment.findUnique`, the to-one pre-fetch with
 * `profile.findFirst`. Prisma's own nested-write execution does not call those JS-level methods.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-upsert-pre-fetch-actor' },
};

const FAILURE_MESSAGE = 'simulated nested pre-fetch failure';

describe('nested upsert and connectOrCreate whose target could not be read', () => {
  let sharedDatabaseUrl: string;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  const createClient = () => {
    const rawBasePrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: sharedDatabaseUrl }) });

    const armed = { commentFindUnique: false, profileFindFirst: false };
    const basePrisma = rawBasePrisma.$extends({
      name: 'fault-injection',
      query: {
        comment: {
          async findUnique({ args, query }) {
            if (armed.commentFindUnique) {
              armed.commentFindUnique = false;
              throw new Error(FAILURE_MESSAGE);
            }
            return query(args);
          },
        },
        profile: {
          async findFirst({ args, query }) {
            if (armed.profileFindFirst) {
              armed.profileFindFirst = false;
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
      schema: auditSchema,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      security: { redact: { fields: [] } },
      errorHandling: { observer },
    });

    return { rawBasePrisma, basePrisma, provider, prisma, observer, armed };
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

  const expectPreFetchFailureReported = (observer: ReturnType<typeof vi.fn<AuditErrorObserver>>) => {
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pre-fetch', error: expect.objectContaining({ message: FAILURE_MESSAGE }) }),
    );
  };

  it('records no entry for a to-many upsert that updated a row it could not read', async () => {
    const { basePrisma, provider, prisma, observer, armed, post, comment } = await setUp();

    armed.commentFindUnique = true;
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
    const { basePrisma, provider, prisma, observer, armed, user, comment } = await setUp();
    const otherPost = await basePrisma.post.create({ data: { title: 'Other', content: 'other', authorId: user.id } });

    armed.commentFindUnique = true;
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
    const { basePrisma, provider, prisma, observer, armed, user } = await setUp();
    await basePrisma.profile.create({ data: { userId: user.id, bio: 'Original' } });

    armed.profileFindFirst = true;
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
