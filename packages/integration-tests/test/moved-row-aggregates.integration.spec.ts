/**
 * Integration Test: aggregates of a row moved to another parent
 *
 * An update that changes the foreign key a `to()` root is resolved from records the row under
 * the aggregate it left as well as the one it joined, from the row as read before the write. An
 * update that keeps the foreign key records it under that one aggregate. Without the row before
 * the write (`fetchBefore.update` off) only the aggregate it joined is known. A row a nested write
 * links to its parent and a nested delete or deleteMany then removes in the same write is recorded
 * under the aggregate it left and the one it was deleted from. Prisma runs the keywords of one
 * relation field in the order the data lists them, so a deleteMany removes the rows linked to the
 * parent by the keywords before it and not those detached or deleted by them.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { EntityMap } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'moved-row-actor' },
};

const entities: EntityMap = {
  ...testEntities,
  Label: defineEntity({ type: 'Label', aggregates: [to('Post', foreignKey('postId'))] }),
  Badge: defineEntity({ type: 'Badge', aggregates: [to('User', foreignKey('userId'))] }),
};

describe('aggregates of a row moved to another parent', () => {
  const disconnects: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async (options: { readonly fetchBeforeUpdate?: boolean } = {}) => {
    const basePrisma = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities,
      diffExcludeFields: ['createdAt', 'updatedAt'],
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
    /** The stored before states of one entity row's records, one per record */
    const beforeStatesOf = async (entityType: string, entityId: string) =>
      (
        await basePrisma.auditLog.findMany({
          where: { entityType, entityId },
          select: { before: true, beforeUnavailable: true },
        })
      ).map((log) => [log.before, log.beforeUnavailable]);

    await basePrisma.user.create({ data: { id: 'u-a', email: 'a@example.com', name: 'A' } });
    await basePrisma.user.create({ data: { id: 'u-b', email: 'b@example.com', name: 'B' } });
    await basePrisma.post.create({ data: { id: 'p1', title: 'Moved', authorId: 'u-a' } });

    return { basePrisma, prisma, run, recordsOf, beforeStatesOf };
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

  it.each([
    ['connect', { connect: { id: 'p1' } }],
    ['set', { set: [{ id: 'p1' }] }],
  ])(
    'records a post a nested %s moves to user B and a nested delete then removes under both users',
    async (_keyword, link) => {
      const { prisma, run, recordsOf, beforeStatesOf } = await setup();

      await run(() => prisma.user.update({ where: { id: 'u-b' }, data: { posts: { ...link, delete: { id: 'p1' } } } }));

      expect(await recordsOf('Post', 'p1')).toEqual([
        ['Post', 'p1', 'delete', null],
        ['User', 'u-a', 'delete', null],
        ['User', 'u-b', 'delete', null],
      ]);
      const before = [expect.objectContaining({ id: 'p1', title: 'Moved', authorId: 'u-a' }), false];
      expect(await beforeStatesOf('Post', 'p1')).toEqual([before, before, before]);
    },
  );

  it('records a badge a nested to-one connect moves to user B and a nested delete then removes under both users', async () => {
    const { basePrisma, prisma, run, recordsOf, beforeStatesOf } = await setup();
    await basePrisma.badge.create({ data: { id: 'b1', name: 'b1', userId: 'u-a' } });

    await run(() =>
      prisma.user.update({ where: { id: 'u-b' }, data: { badge: { connect: { id: 'b1' }, delete: true } } }),
    );

    expect(await basePrisma.badge.findUnique({ where: { id: 'b1' } })).toBeNull();
    expect(await recordsOf('Badge', 'b1')).toEqual([
      ['Badge', 'b1', 'delete', null],
      ['User', 'u-a', 'delete', null],
      ['User', 'u-b', 'delete', null],
    ]);
    const before = [expect.objectContaining({ id: 'b1', userId: 'u-a' }), false];
    expect(await beforeStatesOf('Badge', 'b1')).toEqual([before, before, before]);
  });

  it('records a post a nested delete removes without moving it under its author only', async () => {
    const { prisma, run, recordsOf, beforeStatesOf } = await setup();

    await run(() => prisma.user.update({ where: { id: 'u-a' }, data: { posts: { delete: { id: 'p1' } } } }));

    expect(await recordsOf('Post', 'p1')).toEqual([
      ['Post', 'p1', 'delete', null],
      ['User', 'u-a', 'delete', null],
    ]);
    const before = [expect.objectContaining({ id: 'p1', authorId: 'u-a' }), false];
    expect(await beforeStatesOf('Post', 'p1')).toEqual([before, before]);
  });

  it.each([
    ['connect', { connect: { id: 'p1' } }],
    ['set', { set: [{ id: 'p1' }] }],
    ['connectOrCreate', { connectOrCreate: { where: { id: 'p1' }, create: { title: 'Created' } } }],
  ])(
    'records a post a nested %s moves to user B and a nested deleteMany then removes under both users',
    async (_keyword, link) => {
      const { basePrisma, prisma, run, recordsOf, beforeStatesOf } = await setup();

      await run(() =>
        prisma.user.update({ where: { id: 'u-b' }, data: { posts: { ...link, deleteMany: { title: 'Moved' } } } }),
      );

      expect(await basePrisma.post.findUnique({ where: { id: 'p1' } })).toBeNull();
      expect(await recordsOf('Post', 'p1')).toEqual([
        ['Post', 'p1', 'delete', null],
        ['User', 'u-a', 'delete', null],
        ['User', 'u-b', 'delete', null],
      ]);
      const before = [expect.objectContaining({ id: 'p1', title: 'Moved', authorId: 'u-a' }), false];
      expect(await beforeStatesOf('Post', 'p1')).toEqual([before, before, before]);
    },
  );

  it('records a post a nested deleteMany listed before a connect leaves in place as moved only', async () => {
    const { basePrisma, prisma, run, recordsOf } = await setup();

    await run(() =>
      prisma.user.update({
        where: { id: 'u-b' },
        data: { posts: { deleteMany: { title: 'Moved' }, connect: { id: 'p1' } } },
      }),
    );

    expect(await basePrisma.post.findUnique({ where: { id: 'p1' } })).toMatchObject({ authorId: 'u-b' });
    expect(await recordsOf('Post', 'p1')).toEqual([
      ['Post', 'p1', 'update', moveFromAToB],
      ['User', 'u-a', 'update', moveFromAToB],
      ['User', 'u-b', 'update', moveFromAToB],
    ]);
  });

  it.each([
    ['disconnect', { disconnect: { id: 'l1' } }],
    ['set', { set: [] }],
  ])('records no delete of a label a nested %s detaches before a nested deleteMany', async (_keyword, detach) => {
    const { basePrisma, prisma, run, recordsOf } = await setup();
    await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p1' } });

    await run(() => prisma.post.update({ where: { id: 'p1' }, data: { labels: { ...detach, deleteMany: {} } } }));

    expect(await basePrisma.label.findUnique({ where: { id: 'l1' } })).toMatchObject({ postId: null });
    const detached = { postId: { old: 'p1', new: null } };
    expect(await recordsOf('Label', 'l1')).toEqual([
      ['Label', 'l1', 'update', detached],
      ['Post', 'p1', 'update', detached],
    ]);
  });

  it('records a label a nested delete removes before a nested deleteMany once', async () => {
    const { basePrisma, prisma, run, recordsOf } = await setup();
    await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p1' } });

    await run(() =>
      prisma.post.update({ where: { id: 'p1' }, data: { labels: { delete: { id: 'l1' }, deleteMany: {} } } }),
    );

    expect(await recordsOf('Label', 'l1')).toEqual([
      ['Label', 'l1', 'delete', null],
      ['Post', 'p1', 'delete', null],
    ]);
  });

  it('records no update of a label a nested deleteMany removes before a nested updateMany', async () => {
    const { basePrisma, prisma, run, recordsOf } = await setup();
    await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p1' } });
    await basePrisma.label.create({ data: { id: 'l2', name: 'l2', postId: 'p1' } });

    await run(() =>
      prisma.post.update({
        where: { id: 'p1' },
        data: { labels: { deleteMany: { name: 'l1' }, updateMany: { where: {}, data: { name: 'renamed' } } } },
      }),
    );

    expect(await recordsOf('Label', 'l1')).toEqual([
      ['Label', 'l1', 'delete', null],
      ['Post', 'p1', 'delete', null],
    ]);
    const renamed = { name: { old: 'l2', new: 'renamed' } };
    expect(await recordsOf('Label', 'l2')).toEqual([
      ['Label', 'l2', 'update', renamed],
      ['Post', 'p1', 'update', renamed],
    ]);
  });
});
