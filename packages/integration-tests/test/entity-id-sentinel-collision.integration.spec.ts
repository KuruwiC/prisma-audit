/**
 * Integration Test: a real primary key never collides with the unresolved-identity marker
 *
 * Nested pre-fetch results are keyed by entity identity, with a separate marker for a record
 * whose identity could not be determined. A caller-supplied string primary key is arbitrary, so
 * no string value may be treated as that marker: a row whose id happens to be `'__default__'`
 * must be audited exactly like any other row.
 *
 * The nested delete is exercised with the before-state fetch disabled (identity comes only from
 * the operation's WHERE) and with the default configuration (identity comes from the pre-fetched
 * row).
 */

import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

type NestedOperationsConfig = Parameters<typeof createAuditClient>[1]['nestedOperations'];

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'entity-id-collision-actor' },
};

const COLLIDING_ID = '__default__';

describe('nested delete of a row whose primary key is "__default__"', () => {
  let basePrisma: PrismaClient;
  let observer: ReturnType<typeof vi.fn<AuditErrorObserver>>;

  beforeAll(async () => {
    basePrisma = new PrismaClient({ datasources: { db: { url: await getSharedDatabaseUrl() } } });
  });

  afterAll(async () => {
    await basePrisma?.$disconnect();
  });

  beforeEach(async () => {
    observer = vi.fn<AuditErrorObserver>();
    await basePrisma.postTag.deleteMany({ where: { id: COLLIDING_ID } });
    await basePrisma.auditLog.deleteMany({ where: { entityId: COLLIDING_ID } });
  });

  const createClient = (nestedOperations: NestedOperationsConfig | undefined) => {
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      nestedOperations,
      errorHandling: { observer },
    });
    return { provider, prisma };
  };

  const seedPostTag = async (postTagId: string) => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await basePrisma.user.create({ data: { email: `collision-${runId}@example.com`, name: 'Owner' } });
    const post = await basePrisma.post.create({ data: { title: 'Tagged', authorId: user.id } });
    const tag = await basePrisma.tag.create({ data: { name: `collision-${runId}` } });
    await basePrisma.postTag.create({ data: { id: postTagId, postId: post.id, tagId: tag.id } });
    return { user, post, tag };
  };

  const deleteThroughParent = async (nestedOperations: NestedOperationsConfig | undefined, postTagId: string) => {
    const { provider, prisma } = createClient(nestedOperations);
    const seed = await seedPostTag(postTagId);

    await provider.runAsync(testActor, async () =>
      prisma.post.update({
        where: { id: seed.post.id },
        data: { postTags: { delete: { id: postTagId } } },
      }),
    );

    const remaining = await basePrisma.postTag.findUnique({ where: { id: postTagId } });
    const logs = await basePrisma.auditLog.findMany({
      where: { entityType: 'PostTag', entityId: postTagId, action: 'delete' },
    });

    await basePrisma.tag.delete({ where: { id: seed.tag.id } });
    await basePrisma.user.delete({ where: { id: seed.user.id } });
    return { seed, remaining, logs: logs.map((log) => [log.aggregateType, log.aggregateId]).sort() };
  };

  it('logs the delete when the before-state fetch is disabled, as for any other id', async () => {
    const config: NestedOperationsConfig = { delete: { fetchBeforeOperation: false } };
    const regularId = `regular-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const regular = await deleteThroughParent(config, regularId);
    const colliding = await deleteThroughParent(config, COLLIDING_ID);

    // Without the before-state only the id from the WHERE is known, so the foreign keys that
    // resolve the Post and Tag aggregates are absent and only the PostTag's own log is written.
    expect(regular.remaining).toBeNull();
    expect(regular.logs).toEqual([['PostTag', regularId]]);
    expect(colliding.remaining).toBeNull();
    expect(colliding.logs).toEqual([['PostTag', COLLIDING_ID]]);
    expect(observer).not.toHaveBeenCalled();
  });

  it('logs the delete with the default configuration', async () => {
    const { seed, remaining, logs } = await deleteThroughParent(undefined, COLLIDING_ID);

    expect(remaining).toBeNull();
    // One log per aggregate the PostTag projects onto: itself, its Post and its Tag.
    expect(logs).toEqual(
      [
        ['Post', seed.post.id],
        ['PostTag', COLLIDING_ID],
        ['Tag', seed.tag.id],
      ].sort(),
    );
    expect(observer).not.toHaveBeenCalled();
  });
});
