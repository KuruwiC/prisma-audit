/**
 * Integration Test: aggregates of a row moved to another parent
 *
 * An update that changes the foreign key a `to()` root is resolved from records the row under
 * the aggregate it left as well as the one it joined, from the row as read before the write. An
 * update that keeps the foreign key records it under that one aggregate. Without the row before
 * the write (`fetchBefore.update` off) only the aggregate it joined is known.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'moved-row-actor' },
};

const aggregateMapping: AggregateMapping = {
  ...testAggregateMapping,
  Label: defineEntity({ type: 'Label', aggregates: [to('Post', foreignKey('postId'))] }),
};

describe('aggregates of a row moved to another parent', () => {
  let databaseUrl: string;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async (options: { readonly fetchBeforeUpdate?: boolean } = {}) => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      security: { redact: { fields: [] } },
      fetchBefore: { update: options.fetchBeforeUpdate ?? true, delete: true },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    /** The records of one entity row, as `[aggregateType, aggregateId, action, changes]`, sorted */
    const recordsOf = async (entityType: string, entityId: string) =>
      (
        await basePrisma.auditLog.findMany({
          where: { entityType, entityId },
          select: { aggregateType: true, aggregateId: true, action: true, changes: true },
          orderBy: [{ aggregateType: 'asc' }, { aggregateId: 'asc' }],
        })
      ).map((log) => [log.aggregateType, log.aggregateId, log.action, log.changes]);

    await basePrisma.user.create({ data: { id: 'u-a', email: 'a@example.com', name: 'A' } });
    await basePrisma.user.create({ data: { id: 'u-b', email: 'b@example.com', name: 'B' } });
    await basePrisma.post.create({ data: { id: 'p1', title: 'Moved', authorId: 'u-a' } });

    return { basePrisma, prisma, run, recordsOf };
  };

  const moveFromAToB = { authorId: { old: 'u-a', new: 'u-b' } };

  it('records a post a nested connect moves from user A to user B under both users', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() => prisma.user.update({ where: { id: 'u-b' }, data: { posts: { connect: { id: 'p1' } } } }));

    expect(await recordsOf('Post', 'p1')).toEqual([
      ['Post', 'p1', 'update', moveFromAToB],
      ['User', 'u-a', 'update', moveFromAToB],
      ['User', 'u-b', 'update', moveFromAToB],
    ]);
  });

  it('records a post whose authorId a top-level update changes under the old and the new author', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() => prisma.post.update({ where: { id: 'p1' }, data: { authorId: 'u-b' } }));

    expect(await recordsOf('Post', 'p1')).toEqual([
      ['Post', 'p1', 'update', moveFromAToB],
      ['User', 'u-a', 'update', moveFromAToB],
      ['User', 'u-b', 'update', moveFromAToB],
    ]);
  });

  it('records a label a nested disconnect detaches under the post it left', async () => {
    const { basePrisma, prisma, run, recordsOf } = await setup();
    await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p1' } });

    await run(() => prisma.post.update({ where: { id: 'p1' }, data: { labels: { disconnect: { id: 'l1' } } } }));

    const detached = { postId: { old: 'p1', new: null } };
    expect(await recordsOf('Label', 'l1')).toEqual([
      ['Label', 'l1', 'update', detached],
      ['Post', 'p1', 'update', detached],
    ]);
  });

  it('records an update that keeps the foreign key once under its author', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() => prisma.post.update({ where: { id: 'p1' }, data: { title: 'Renamed' } }));

    const renamed = { title: { old: 'Moved', new: 'Renamed' } };
    expect(await recordsOf('Post', 'p1')).toEqual([
      ['Post', 'p1', 'update', renamed],
      ['User', 'u-a', 'update', renamed],
    ]);
  });

  it('records a moved post under the new author only when its row is not read before the update', async () => {
    const { prisma, run, recordsOf } = await setup({ fetchBeforeUpdate: false });

    await run(() => prisma.post.update({ where: { id: 'p1' }, data: { authorId: 'u-b' } }));

    expect(await recordsOf('Post', 'p1')).toEqual([
      ['Post', 'p1', 'update', null],
      ['User', 'u-b', 'update', null],
    ]);
  });
});
