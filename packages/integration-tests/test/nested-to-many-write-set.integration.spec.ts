/**
 * A nested write on a to-many relation audits exactly the rows it wrote.
 *
 * The relation the operation writes is read back whole, so sibling rows of the same parent come
 * back next to the written ones. Each nested operation is attributed the rows it targeted by
 * WHERE or, for a create, the rows that did not exist under the parent before the operation; a
 * sibling matches no operation and produces no audit entry. Every parent here starts with
 * children on the relation being written, so an over-logged sibling shows up as an extra entry.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-to-many-write-set-actor' },
};

const createClients = (databaseUrl: string, fetchBeforeUpdate = true) => {
  const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
    diffing: { excludeFields: ['createdAt'] },
    security: { redact: { fields: [] } },
    nestedOperations: {
      update: { fetchBeforeOperation: fetchBeforeUpdate },
      delete: { fetchBeforeOperation: true },
    },
  });
  return { basePrisma, provider, prisma };
};

describe('nested to-many write set', () => {
  let databaseUrl: string;
  let clients: ReturnType<typeof createClients>;

  const asActor = <T>(fn: () => Promise<T>): Promise<T> => clients.provider.runAsync(testActor, fn);

  /** A user with posts p1 and p2, each holding one comment */
  const seedUserWithTwoPosts = async (email: string) => {
    const user = await clients.basePrisma.user.create({ data: { email, name: 'Owner', password: 'secret123' } });
    const p1 = await clients.basePrisma.post.create({
      data: { title: 'P1', authorId: user.id, comments: { create: { content: 'c-p1', authorId: user.id } } },
    });
    const p2 = await clients.basePrisma.post.create({
      data: { title: 'P2', authorId: user.id, comments: { create: { content: 'c-p2', authorId: user.id } } },
    });
    return { user, p1, p2 };
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
      after: log.after as Record<string, unknown> | null,
    }));
  };

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  beforeEach(async () => {
    clients = createClients(databaseUrl);
    await cleanDatabase(clients.basePrisma);
  });

  afterEach(async () => {
    await clients.prisma.$disconnect();
    await clients.basePrisma.$disconnect();
  });

  describe('a relation the caller filters in its own include', () => {
    // The caller's `include` keeps its own `where`, so the relation comes back with the rows
    // that filter admits: the sibling p2, but not p1, the post the nested update writes. The
    // written post is still audited, and the caller still receives only the posts it asked for.

    /** A user whose post p1 is unpublished and whose post p2 is published */
    const seedWithPublishedSibling = async (email: string) => {
      const seeded = await seedUserWithTwoPosts(email);
      await clients.basePrisma.post.update({ where: { id: seeded.p2.id }, data: { published: true } });
      return seeded;
    };

    /** The audit rows of the post's update, one per aggregate root, ordered by aggregate type */
    const updateLogsOf = (postId: string) =>
      clients.basePrisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: postId, action: 'update' },
        orderBy: { aggregateType: 'asc' },
      });

    it('audits the updated post the filter leaves out, with its before and after state', async () => {
      const { user, p1, p2 } = await seedWithPublishedSibling('filtered-include@example.com');

      const returned = await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: { posts: { update: { where: { id: p1.id }, data: { title: 'T' } } } },
          include: { posts: { where: { published: true } } },
        }),
      );

      expect(returned.posts.map((post) => post.id)).toEqual([p2.id]);
      const logs = await updateLogsOf(p1.id);
      expect(logs.map((log) => log.aggregateType)).toEqual(['Post', 'User']);
      for (const log of logs) {
        expect(log.before).toMatchObject({ title: 'P1' });
        expect(log.after).toMatchObject({ title: 'T' });
      }
      expect(await clients.basePrisma.auditLog.count({ where: { entityType: 'Post', entityId: p2.id } })).toBe(0);
    });

    it('without a pre-fetch, audits the updated post the filter leaves out as an update without a before state', async () => {
      const { user, p1, p2 } = await seedWithPublishedSibling('filtered-include-no-pre-fetch@example.com');
      const withoutPreFetch = createClients(databaseUrl, false);

      try {
        const returned = await withoutPreFetch.provider.runAsync(testActor, () =>
          withoutPreFetch.prisma.user.update({
            where: { id: user.id },
            data: { posts: { update: { where: { id: p1.id }, data: { title: 'T' } } } },
            include: { posts: { where: { published: true } } },
          }),
        );

        expect(returned.posts.map((post) => post.id)).toEqual([p2.id]);
        const logs = await updateLogsOf(p1.id);
        expect(logs.map((log) => log.aggregateType)).toEqual(['Post', 'User']);
        for (const log of logs) {
          expect(log.before).toBeNull();
          expect(log.after).toMatchObject({ title: 'T' });
        }
        expect(await clients.basePrisma.auditLog.count({ where: { entityType: 'Post', entityId: p2.id } })).toBe(0);
      } finally {
        await withoutPreFetch.prisma.$disconnect();
        await withoutPreFetch.basePrisma.$disconnect();
      }
    });
  });

  it('a nested update audits the targeted post only', async () => {
    const { user, p1 } = await seedUserWithTwoPosts('nested-update@example.com');

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: { posts: { update: { where: { id: p1.id }, data: { title: 'T' } } } },
      }),
    );

    expect(await eventsOf('Post')).toEqual([expect.objectContaining({ entityId: p1.id, action: 'update' })]);
  });

  it('a nested create audits the created post only', async () => {
    const { user } = await seedUserWithTwoPosts('nested-create@example.com');

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: { posts: { create: { title: 'N' } } },
      }),
    );

    const postEvents = await eventsOf('Post');
    expect(postEvents).toHaveLength(1);
    expect(postEvents[0]).toMatchObject({ action: 'create', after: { title: 'N' } });
    expect(await eventsOf('Comment')).toEqual([]);
  });

  it('a nested createMany audits the created posts only', async () => {
    const { user } = await seedUserWithTwoPosts('nested-create-many@example.com');

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: { posts: { createMany: { data: [{ title: 'A' }, { title: 'B' }] } } },
      }),
    );

    const postEvents = await eventsOf('Post');
    expect(postEvents.map((event) => event.action)).toEqual(['create', 'create']);
    expect(postEvents.map((event) => event.after?.title).sort()).toEqual(['A', 'B']);
  });

  it('a nested upsert on an existing post audits that post as an update only', async () => {
    const { user, p1 } = await seedUserWithTwoPosts('nested-upsert@example.com');

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: {
          posts: { upsert: { where: { id: p1.id }, create: { title: 'never' }, update: { title: 'X' } } },
        },
      }),
    );

    expect(await eventsOf('Post')).toEqual([expect.objectContaining({ entityId: p1.id, action: 'update' })]);
  });

  it('a comment created inside a nested post update is audited once, without its siblings', async () => {
    const { user, p1 } = await seedUserWithTwoPosts('nested-update-comment-create@example.com');

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: {
          posts: {
            update: { where: { id: p1.id }, data: { comments: { create: { content: 'c', authorId: user.id } } } },
          },
        },
      }),
    );

    const commentEvents = await eventsOf('Comment');
    expect(commentEvents).toHaveLength(1);
    expect(commentEvents[0]).toMatchObject({ action: 'create', after: { content: 'c', postId: p1.id } });
  });

  it('a nested create of a row with a database-generated key audits the new row only', async () => {
    const user = await clients.basePrisma.user.create({
      data: {
        email: 'auto-inc-child@example.com',
        name: 'Owner',
        password: 'secret123',
        autoIncChildren: { create: [{}, {}] },
      },
    });

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: { autoIncChildren: { create: {} } },
      }),
    );

    const children = await clients.basePrisma.autoIncChild.findMany({ where: { parentId: user.id } });
    const newestId = Math.max(...children.map((child) => child.id));
    expect(await eventsOf('AutoIncChild')).toEqual([
      expect.objectContaining({ entityId: String(newestId), action: 'create' }),
    ]);
  });

  it('an array-form nested upsert takes its branch per element and audits the writes nested in each', async () => {
    const user = await clients.basePrisma.user.create({
      data: { email: 'array-upsert@example.com', name: 'Owner', password: 'secret123' },
    });
    const p1 = await clients.basePrisma.post.create({ data: { title: 'P1', authorId: user.id } });

    await asActor(() =>
      clients.prisma.user.update({
        where: { id: user.id },
        data: {
          posts: {
            upsert: [
              {
                where: { id: p1.id },
                create: { title: 'never' },
                update: { title: 'U', comments: { create: { content: 'c1', authorId: user.id } } },
              },
              {
                where: { id: 'missing' },
                create: { title: 'C', comments: { create: { content: 'c2', authorId: user.id } } },
                update: {},
              },
            ],
          },
        },
      }),
    );

    const createdPost = await clients.basePrisma.post.findFirst({ where: { authorId: user.id, title: 'C' } });
    expect(createdPost).not.toBeNull();

    expect(await eventsOf('Post')).toEqual([
      expect.objectContaining({ entityId: createdPost?.id, action: 'create' }),
      expect.objectContaining({ entityId: p1.id, action: 'update' }),
    ]);
    const commentEvents = await eventsOf('Comment');
    expect(commentEvents.map((event) => event.action)).toEqual(['create', 'create']);
    expect(commentEvents.map((event) => event.after?.content).sort()).toEqual(['c1', 'c2']);
  });
});
