/**
 * Integration Test: the default write stores `beforeUnavailable` only in a column that exists
 *
 * The fixture's `AuditLog` model declares `beforeUnavailable Boolean`, so the default write fills
 * it; the `Activity` model does not, so the default write leaves the field out and the row is
 * stored all the same. The before-state read is failed with a Prisma Client Extension applied
 * before the audit extension, as in `before-state-unavailable.integration.spec.ts`.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPostReadFault } from './helpers/post-read-fault.js';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'before-unavailable-column-actor' },
};

describe('beforeUnavailable column of the audit-log model', () => {
  let sharedDatabaseUrl: string;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  const createClient = (auditLogModel?: 'Activity') => {
    const rawBasePrisma = new PrismaClient({ datasources: { db: { url: sharedDatabaseUrl } } });

    const { findUnique, armFindUniqueFailure } = createPostReadFault('simulated before-state read failure');
    const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: { post: { findUnique } } });

    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      ...(auditLogModel ? { auditLogModel } : {}),
      errorHandling: { writeFailurePolicy: 'throw' },
    });

    return { rawBasePrisma, basePrisma, provider, prisma, armFindUniqueFailure };
  };

  let scenario: ReturnType<typeof createClient> | undefined;

  const setUp = async (auditLogModel?: 'Activity') => {
    scenario = createClient(auditLogModel);
    const { basePrisma, provider, prisma } = scenario;
    await basePrisma.auditLog.deleteMany();
    await basePrisma.activity.deleteMany();
    await basePrisma.post.deleteMany();
    await basePrisma.user.deleteMany();
    const user = await basePrisma.user.create({
      data: { email: 'before-unavailable-column@example.com', name: 'Owner', password: 'secret123' },
    });
    const post = await provider.runAsync(testActor, () =>
      prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
    );
    return { ...scenario, post };
  };

  afterEach(async () => {
    await scenario?.prisma.$disconnect();
    await scenario?.rawBasePrisma.$disconnect();
    scenario = undefined;
  });

  it('fills the column of an update whose before-state read failed', async () => {
    const { basePrisma, provider, prisma, armFindUniqueFailure, post } = await setUp();

    armFindUniqueFailure();
    await provider.runAsync(testActor, () =>
      prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
    );

    const rows = await basePrisma.auditLog.findMany({ where: { entityType: 'Post', action: 'update' } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ before: null, beforeUnavailable: true });
    }
  });

  it('leaves the column false for an update whose before state was read', async () => {
    const { basePrisma, provider, prisma, post } = await setUp();

    await provider.runAsync(testActor, () =>
      prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
    );

    const rows = await basePrisma.auditLog.findMany({ where: { entityType: 'Post', action: 'update' } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ before: expect.objectContaining({ title: 'Original' }), beforeUnavailable: false });
    }
  });

  it('stores the entry in an audit-log model without the column', async () => {
    const { basePrisma, provider, prisma, armFindUniqueFailure, post } = await setUp('Activity');

    armFindUniqueFailure();
    await provider.runAsync(testActor, () =>
      prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } }),
    );

    const rows = await basePrisma.activity.findMany({ where: { entityType: 'Post', action: 'update' } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.before).toBeNull();
    }
  });
});
