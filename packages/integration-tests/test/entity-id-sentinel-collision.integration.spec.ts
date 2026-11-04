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

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
import { setupTestContext, testEntities } from './helpers/setup.js';

type FetchBeforeConfig = Parameters<typeof createAuditClient>[1]['fetchBefore'];

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'entity-id-collision-actor' },
};

const COLLIDING_ID = '__default__';

describe('nested delete of a row whose primary key is "__default__"', () => {
  const context = setupTestContext();
  let observer: ReturnType<typeof vi.fn<AuditObserver>>;

  beforeEach(() => {
    observer = vi.fn<AuditObserver>();
  });

  const createClient = (fetchBefore: FetchBeforeConfig | undefined) => {
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(context.basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      diffExcludeFields: ['createdAt'],
      fetchBefore,
      observer,
    });
    return { provider, prisma };
  };

  const seedPostTag = async (postTagId: string) => {
    const user = await context.basePrisma.user.create({
      data: { email: `${postTagId}@example.com`, name: 'Owner' },
    });
    const post = await context.basePrisma.post.create({ data: { title: 'Tagged', authorId: user.id } });
    const tag = await context.basePrisma.tag.create({ data: { name: postTagId } });
    await context.basePrisma.postTag.create({ data: { id: postTagId, postId: post.id, tagId: tag.id } });
    return { user, post, tag };
  };

  const deleteThroughParent = async (fetchBefore: FetchBeforeConfig | undefined, postTagId: string) => {
    const { provider, prisma } = createClient(fetchBefore);
    const seed = await seedPostTag(postTagId);

    await provider.runAsync(testActor, async () =>
      prisma.post.update({
        where: { id: seed.post.id },
        data: { postTags: { delete: { id: postTagId } } },
      }),
    );

    const remaining = await context.basePrisma.postTag.findUnique({ where: { id: postTagId } });
    const logs = await context.basePrisma.auditLog.findMany({
      where: { entityType: 'PostTag', entityId: postTagId, action: 'delete' },
    });

    return { seed, remaining, logs: logs.map((log) => [log.aggregateType, log.aggregateId]).sort() };
  };

  it('logs the delete when the before-state fetch is disabled, as for any other id', async () => {
    const config: FetchBeforeConfig = { delete: false };
    const regularId = 'regular-post-tag';

    const regular = await deleteThroughParent(config, regularId);
    const colliding = await deleteThroughParent(config, COLLIDING_ID);

    // Without the before-state the row is known by the id its WHERE names and the post it was
    // deleted through, so the Post aggregate resolves; the Tag key is not known and that root is
    // left out.
    expect(regular.remaining).toBeNull();
    expect(regular.logs).toEqual([
      ['Post', regular.seed.post.id],
      ['PostTag', regularId],
    ]);
    expect(colliding.remaining).toBeNull();
    expect(colliding.logs).toEqual([
      ['Post', colliding.seed.post.id],
      ['PostTag', COLLIDING_ID],
    ]);
    expect(failuresOf(observer)).toEqual([]);
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
    expect(failuresOf(observer)).toEqual([]);
  });
});
