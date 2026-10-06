/**
 * Integration Test: a before state that was requested and could not be read
 *
 * A top-level update or delete reads its target row with `findUnique` before the write. When that
 * read fails, the caller's write still succeeds, the failure reaches the observer under
 * `pre-fetch`, and the audit record says so with `beforeUnavailable: true` instead of looking like
 * an update whose before state was never requested.
 *
 * The read failure is injected with a Prisma Client Extension applied before the audit extension,
 * as in `upsert-before-state-failure.integration.spec.ts`; Prisma's own execution of the update
 * does not call the JS-level `findUnique`, so only the audit read fails.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver, AuditLogData } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostReadFault } from './helpers/post-read-fault.js';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

type FetchBeforeConfig = Parameters<typeof createAuditClient>[1]['fetchBefore'];

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'before-state-unavailable-actor' },
};

const FAILURE_MESSAGE = 'simulated before-state read failure';

describe('before state requested but unreadable', () => {
  let sharedDatabaseUrl: string;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  const createClient = (options: { fetchBefore?: FetchBeforeConfig } = {}) => {
    const rawBasePrisma = new PrismaClient({ datasources: { db: { url: sharedDatabaseUrl } } });

    const { findUnique, armFindUniqueFailure } = createPostReadFault(FAILURE_MESSAGE);
    const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: { post: { findUnique } } });

    const observer = vi.fn<AuditErrorObserver>();
    const written: AuditLogData[] = [];
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      errorHandling: { observer },
      ...options,
      hooks: {
        writer: async (records, { defaultWrite }) => {
          written.push(...records);
          await defaultWrite(records);
        },
      },
    });
    const postRecords = () => written.filter((log) => log.entityType === 'Post');

    return { rawBasePrisma, basePrisma, provider, prisma, observer, armFindUniqueFailure, postRecords };
  };

  let scenario: ReturnType<typeof createClient> | undefined;

  const setUp = async (options?: { fetchBefore?: FetchBeforeConfig }) => {
    scenario = createClient(options);
    const { basePrisma, provider, prisma } = scenario;
    await basePrisma.auditLog.deleteMany();
    await basePrisma.post.deleteMany();
    await basePrisma.user.deleteMany();
    const user = await basePrisma.user.create({
      data: { email: 'before-unavailable@example.com', name: 'Owner', password: 'secret123' },
    });
    const post = await provider.runAsync(testActor, () =>
      prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
    );
    scenario.observer.mockClear();
    return { ...scenario, post };
  };

  afterEach(async () => {
    await scenario?.prisma.$disconnect();
    await scenario?.rawBasePrisma.$disconnect();
    scenario = undefined;
  });

  it('records an update whose before-state read failed as unavailable, and the write succeeds', async () => {
    const { basePrisma, provider, prisma, observer, armFindUniqueFailure, postRecords, post } = await setUp();

    armFindUniqueFailure();
    await provider.runAsync(testActor, () =>
      prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
    );

    expect((await basePrisma.post.findUnique({ where: { id: post.id } }))?.title).toBe('Updated');
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'pre-fetch',
        modelName: 'Post',
        operation: 'update',
        error: expect.objectContaining({ message: FAILURE_MESSAGE }),
      }),
    );
    const updates = postRecords().filter((log) => log.action === 'update');
    expect(updates).toHaveLength(2);
    for (const log of updates) {
      expect(log).toMatchObject({ before: null, changes: null, beforeUnavailable: true });
    }
  });

  it('records an update whose before state was read as not unavailable', async () => {
    const { provider, prisma, postRecords, post } = await setUp();

    await provider.runAsync(testActor, () =>
      prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
    );

    const updates = postRecords().filter((log) => log.action === 'update');
    expect(updates).toHaveLength(2);
    for (const log of updates) {
      expect(log).toMatchObject({ before: expect.objectContaining({ title: 'Original' }), beforeUnavailable: false });
    }
  });

  it('records a delete whose before-state read failed as unavailable', async () => {
    const { basePrisma, provider, prisma, observer, armFindUniqueFailure, postRecords, post } = await setUp();

    armFindUniqueFailure();
    await provider.runAsync(testActor, () => prisma.post.delete({ where: { id: post.id } }));

    expect(await basePrisma.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(observer).toHaveBeenCalledTimes(1);
    const deletes = postRecords().filter((log) => log.action === 'delete');
    expect(deletes).toHaveLength(2);
    for (const log of deletes) {
      expect(log).toMatchObject({ before: null, beforeUnavailable: true });
    }
  });

  it('does not mark an update whose before state was not requested', async () => {
    const { provider, prisma, observer, postRecords, post } = await setUp({
      fetchBefore: { update: false },
    });

    await provider.runAsync(testActor, () =>
      prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
    );

    expect(observer).not.toHaveBeenCalled();
    const updates = postRecords().filter((log) => log.action === 'update');
    expect(updates).toHaveLength(2);
    for (const log of updates) {
      expect(log).toMatchObject({ before: null, beforeUnavailable: false });
    }
  });
});
