/**
 * A nested `updateMany` / `deleteMany` audits exactly the rows its filter matches under the parent row.
 *
 * The filter of a nested batch keyword is a scalar WHERE that Prisma scopes to the parent row when
 * it runs the write. The audit reads the matched rows ahead of the write with the same scope: the
 * rows of another parent that match the filter are not written and produce no entry, and neither
 * do the sibling rows of the parent the filter does not match.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-batch-parent-scope-actor' },
};

const createClients = (fetchBeforeUpdate: boolean) => {
  const basePrisma = createBasePrisma();
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    contextProvider: provider,
    entities: testEntities,
    diffing: { excludeFields: ['createdAt'] },
    security: { redact: { fields: [] } },
    fetchBefore: {
      update: fetchBeforeUpdate,
      delete: true,
    },
  });
  return { basePrisma, provider, prisma };
};

describe('nested updateMany / deleteMany parent scope', () => {
  let clients: ReturnType<typeof createClients>;

  const asActor = <T>(fn: () => Promise<T>): Promise<T> => clients.provider.runAsync(testActor, fn);

  /** Users A (posts a1 unpublished, a2 published) and B (post b1 unpublished) */
  const seedTwoUsers = async () => {
    const userA = await clients.basePrisma.user.create({
      data: { email: 'batch-a@example.com', name: 'A', password: 'secret123' },
    });
    const userB = await clients.basePrisma.user.create({
      data: { email: 'batch-b@example.com', name: 'B', password: 'secret123' },
    });
    const a1 = await clients.basePrisma.post.create({ data: { title: 'A1', published: false, authorId: userA.id } });
    const a2 = await clients.basePrisma.post.create({ data: { title: 'A2', published: true, authorId: userA.id } });
    const b1 = await clients.basePrisma.post.create({ data: { title: 'B1', published: false, authorId: userB.id } });
    return { userA, userB, a1, a2, b1 };
  };

  /**
   * One row per audited event of `entityType`: the row whose aggregate is the entity itself. The
   * rows propagated to the entity's other aggregate roots repeat the same event.
   */
  const eventsOf = async (entityType: string) => {
    const logs = await clients.basePrisma.auditLog.findMany({
      where: { entityType, aggregateType: entityType },
      orderBy: [{ action: 'asc' }, { entityId: 'asc' }],
    });
    return logs.map((log) => ({
      entityId: log.entityId,
      action: log.action,
      before: log.before as Record<string, unknown> | null,
      after: log.after as Record<string, unknown> | null,
    }));
  };

  const rowsFor = (entityType: string, entityId: string) =>
    clients.basePrisma.auditLog.findMany({
      where: { entityType, entityId },
      select: { action: true, aggregateType: true },
      orderBy: { aggregateType: 'asc' },
    });

  beforeEach(async () => {
    clients = createClients(true);
    await cleanDatabase(clients.basePrisma);
  });

  afterEach(async () => {
    await clients.prisma.$disconnect();
    await clients.basePrisma.$disconnect();
  });

  it('a nested updateMany audits the matched posts of the parent only, with their before state', async () => {
    const { userA, a1, a2, b1 } = await seedTwoUsers();

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: userA.id },
        data: { posts: { updateMany: { where: { published: false }, data: { title: 'x' } } } },
      }),
    );

    expect(await eventsOf('Post')).toEqual([
      {
        entityId: a1.id,
        action: 'update',
        before: expect.objectContaining({ title: 'A1' }),
        after: expect.objectContaining({ title: 'x' }),
      },
    ]);
    expect(await rowsFor('Post', a1.id)).toEqual([
      { action: 'update', aggregateType: 'Post' },
      { action: 'update', aggregateType: 'User' },
    ]);
    expect(await rowsFor('Post', a2.id)).toEqual([]);
    expect(await rowsFor('Post', b1.id)).toEqual([]);
  });

  it('a nested deleteMany audits the matched posts of the parent only, from their before state', async () => {
    const { userA, a1, a2, b1 } = await seedTwoUsers();

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: userA.id },
        data: { posts: { deleteMany: { published: false } } },
      }),
    );

    expect(await eventsOf('Post')).toEqual([
      { entityId: a1.id, action: 'delete', before: expect.objectContaining({ title: 'A1' }), after: null },
    ]);
    expect(await rowsFor('Post', a1.id)).toEqual([
      { action: 'delete', aggregateType: 'Post' },
      { action: 'delete', aggregateType: 'User' },
    ]);
    expect(await rowsFor('Post', a2.id)).toEqual([]);
    expect(await rowsFor('Post', b1.id)).toEqual([]);
    expect(await clients.basePrisma.post.findUnique({ where: { id: b1.id } })).not.toBeNull();
  });

  it('a nested updateMany without a before-state read still audits the matched posts of the parent only', async () => {
    await clients.prisma.$disconnect();
    await clients.basePrisma.$disconnect();
    clients = createClients(false);
    const { userA, a1, a2, b1 } = await seedTwoUsers();

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: userA.id },
        data: { posts: { updateMany: { where: { published: false }, data: { title: 'x' } } } },
      }),
    );

    expect(await eventsOf('Post')).toEqual([
      { entityId: a1.id, action: 'update', before: null, after: expect.objectContaining({ title: 'x' }) },
    ]);
    expect(await rowsFor('Post', a2.id)).toEqual([]);
    expect(await rowsFor('Post', b1.id)).toEqual([]);
  });

  it('a nested updateMany two levels down audits the matched comments of its own parent post only', async () => {
    const { userA, a1, a2 } = await seedTwoUsers();
    const c1 = await clients.basePrisma.comment.create({
      data: { content: 'draft', postId: a1.id, authorId: userA.id },
    });
    const c2 = await clients.basePrisma.comment.create({
      data: { content: 'final', postId: a1.id, authorId: userA.id },
    });
    const c3 = await clients.basePrisma.comment.create({
      data: { content: 'draft', postId: a2.id, authorId: userA.id },
    });

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: userA.id },
        data: {
          posts: {
            update: {
              where: { id: a1.id },
              data: { comments: { updateMany: { where: { content: 'draft' }, data: { content: 'revised' } } } },
            },
          },
        },
      }),
    );

    expect(await eventsOf('Comment')).toEqual([
      {
        entityId: c1.id,
        action: 'update',
        before: expect.objectContaining({ content: 'draft' }),
        after: expect.objectContaining({ content: 'revised' }),
      },
    ]);
    expect(await rowsFor('Comment', c2.id)).toEqual([]);
    expect(await rowsFor('Comment', c3.id)).toEqual([]);
    expect((await clients.basePrisma.comment.findUnique({ where: { id: c3.id } }))?.content).toBe('draft');
  });
});
