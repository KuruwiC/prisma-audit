/**
 * Integration Test: upsert action resolution when the before-state fetch fails
 *
 * `createFetchBeforeStateStage` always pre-fetches the before-state for `upsert`
 * (to tell create from update), via a `findUnique` call distinct from Prisma's own
 * upsert execution. If that pre-fetch throws, the failure must not silently make
 * the operation look like a `create` in the audit log: an upsert that in fact
 * updated an existing row must never be recorded with `action: 'create'`.
 *
 * The pre-fetch failure is injected with a plain Prisma Client Extension applied
 * *before* the audit extension (`basePrisma.$extends({ query: { post: { findUnique... } } })`),
 * the same public mechanism `hooks.writer` fault-injection tests use on the write
 * side (see error-handling.integration.spec.ts). Because the audit extension's own
 * `fetchBeforeState` calls `clientToUse.post.findUnique(...)`, and `clientToUse`
 * always derives from this same extended client (directly, or via `$transaction`,
 * which carries extensions through), the injected failure reaches it regardless of
 * the `awaitWrite` setting. Prisma's own upsert execution does not call back into
 * the JS-level `findUnique` method, so it is unaffected.
 */

import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'upsert-before-state-actor' },
};

const FAILURE_MESSAGE = 'simulated before-state fetch failure';

describe('upsert — before-state fetch failure', () => {
  let sharedDatabaseUrl: string;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  const createClient = (databaseUrl: string, observer: AuditErrorObserver) => {
    const rawBasePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    // One-shot fault: the next `post.findUnique` call throws, everything else
    // (including the query's own `findUnique` calls made outside this test) works
    // normally.
    let failNextFindUnique = false;
    const basePrisma = rawBasePrisma.$extends({
      name: 'fault-injection',
      query: {
        post: {
          async findUnique({ args, query }) {
            if (failNextFindUnique) {
              failNextFindUnique = false;
              throw new Error(FAILURE_MESSAGE);
            }
            return query(args);
          },
        },
      },
    });
    const armFindUniqueFailure = () => {
      failNextFindUnique = true;
    };

    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      errorHandling: { observer },
    });
    return { basePrisma, rawBasePrisma, provider, prisma, armFindUniqueFailure };
  };

  let scenario: ReturnType<typeof createClient>;
  let observer: ReturnType<typeof vi.fn<AuditErrorObserver>>;

  beforeEach(async () => {
    observer = vi.fn<AuditErrorObserver>();
    scenario = createClient(sharedDatabaseUrl, observer);
    await scenario.basePrisma.auditLog.deleteMany();
    await scenario.basePrisma.post.deleteMany();
    await scenario.basePrisma.user.deleteMany();
  });

  afterAll(async () => {
    await scenario?.rawBasePrisma.$disconnect();
  });

  it('does not record an update-through-upsert as `create` when the before-state fetch fails', async () => {
    const { prisma, basePrisma, provider, armFindUniqueFailure } = scenario;

    const user = await provider.runAsync(testActor, async () =>
      prisma.user.create({ data: { email: 'upsert-owner@example.com', name: 'Owner', password: 'secret123' } }),
    );
    const post = await provider.runAsync(testActor, async () =>
      prisma.post.create({ data: { title: 'Original Title', content: 'original', authorId: user.id } }),
    );

    await basePrisma.auditLog.deleteMany();
    armFindUniqueFailure();

    const upserted = await provider.runAsync(testActor, async () =>
      prisma.post.upsert({
        where: { id: post.id },
        create: { title: 'Should never be used', content: 'wrong branch', authorId: user.id },
        update: { title: 'Updated Through Upsert' },
      }),
    );

    // The row was genuinely updated, not recreated — Prisma's own upsert execution
    // does not go through the JS `findUnique` method, so it is unaffected by the
    // fault injection above.
    expect(upserted.id).toBe(post.id);
    expect(upserted.title).toBe('Updated Through Upsert');
    const rowCount = await basePrisma.post.count({ where: { authorId: user.id } });
    expect(rowCount).toBe(1);

    // The failure was reported through the read-only observer.
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'pre-fetch',
        modelName: 'Post',
        error: expect.objectContaining({ message: FAILURE_MESSAGE }),
      }),
    );

    // The core requirement: this update-through-upsert must never be recorded as 'create'.
    const logs = await basePrisma.auditLog.findMany({ where: { entityType: 'Post', entityId: post.id } });
    expect(logs.some((log) => log.action === 'create')).toBe(false);
  });
});
