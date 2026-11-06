/**
 * Integration Test: a before state that was requested and could not be read
 *
 * A top-level update or delete reads its target row with `findUnique` before the write. When that
 * read fails, the caller's write still succeeds, the failure reaches the observer under
 * `pre-fetch`, and the audit record says so with `beforeUnavailable: true` instead of looking like
 * an update whose before state was never requested.
 *
 * The read failure is injected with a Prisma Client Extension applied before the audit extension,
 * as in `top-level-upsert-nested.integration.spec.ts`; Prisma's own execution of the update
 * does not call the JS-level `findUnique`, so only the audit read fails.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditLogData, AuditObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
import { createReadFault } from './helpers/read-fault.js';
import { createBasePrisma, testEntities } from './helpers/setup.js';

type FetchBeforeConfig = Parameters<typeof createAuditClient>[1]['fetchBefore'];

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'before-state-unavailable-actor' },
};

const FAILURE_MESSAGE = 'simulated before-state read failure';

describe('before state requested but unreadable', () => {
  const createClient = (options: { fetchBefore?: FetchBeforeConfig } = {}) => {
    const rawBasePrisma = createBasePrisma();

    const readFault = createReadFault();

    const armFindUniqueFailure = () => readFault.arm({ model: 'Post', operation: 'findUnique' }, FAILURE_MESSAGE);
    const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: readFault.query });

    const observer = vi.fn<AuditObserver>();
    const written: AuditLogData[] = [];
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      diffExcludeFields: ['createdAt'],
      observer,
      ...options,
      write: {
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
    expect(observer.mock.calls).toEqual([
      [
        expect.objectContaining({
          model: 'Post',
          operation: 'delete',
          status: 'complete',
          failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'Post', operation: 'delete' })],
        }),
      ],
    ]);
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

    expect(failuresOf(observer)).toEqual([]);
    const updates = postRecords().filter((log) => log.action === 'update');
    expect(updates).toHaveLength(2);
    for (const log of updates) {
      expect(log).toMatchObject({ before: null, beforeUnavailable: false });
    }
  });
});
