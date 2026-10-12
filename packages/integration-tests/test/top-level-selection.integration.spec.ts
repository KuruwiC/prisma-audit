/**
 * Integration Test: an audited row read in the client's default shape whatever the caller selects
 *
 * A caller's `select` or `omit` decides the shape of the value it receives, not the row the
 * audit records: the before and after states, `changes` and the resolvers see every column of
 * the row the client reads by default, and the caller receives exactly the keys it asked for.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'top-level-selection-actor' },
};

const USER_COLUMNS = ['createdAt', 'email', 'id', 'name', 'password', 'updatedAt'];
const POST_COLUMNS = ['authorId', 'content', 'createdAt', 'id', 'published', 'title', 'updatedAt'];

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];

describe("an audited row read in the client's default shape whatever the caller selects", () => {
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

  const setup = async () => {
    const basePrisma = createBasePrisma(databaseUrl);
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: { ...testAggregateMapping, Subscription: defineEntity({ type: 'Subscription' }) },
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    /** The records of `entityType` under its own aggregate, by entity id */
    const recordsOf = async (entityType: string) =>
      basePrisma.auditLog.findMany({ where: { entityType, aggregateType: entityType }, orderBy: { entityId: 'asc' } });
    const recordOf = async (entityType: string, entityId: string) => {
      const records = await basePrisma.auditLog.findMany({
        where: { entityType, entityId, aggregateType: entityType },
      });
      expect(records).toHaveLength(1);
      return records[0];
    };
    /** `entityId:aggregateType:aggregateId` of every record of `entityType`, sorted */
    const aggregatesOf = async (entityType: string) =>
      (await basePrisma.auditLog.findMany({ where: { entityType } }))
        .map((log) => `${log.entityId}:${log.aggregateType}:${log.aggregateId}`)
        .sort();

    await basePrisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'Ada' } });
    await basePrisma.post.create({ data: { id: 'p1', title: 'T1', content: 'Body', authorId: 'u1' } });

    return { basePrisma, prisma, run, recordsOf, recordOf, aggregatesOf };
  };

  describe('a top-level select', () => {
    it('records only the columns an update changed, and returns the selected fields', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' }, select: { id: true, name: true } }),
      );

      expect(result).toEqual({ id: 'u1', name: 'Bea' });
      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
      expect(keysOf(record?.before)).toEqual(USER_COLUMNS);
      expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
    });

    it('records a change of a column the caller does not select', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { email: 'u1b@example.com' }, select: { id: true } }),
      );

      expect(result).toEqual({ id: 'u1' });
      expect((await recordOf('User', 'u1'))?.changes).toEqual({
        email: { old: 'u1@example.com', new: 'u1b@example.com' },
      });
    });

    it('records the row an upsert updates whole, and returns the selected fields', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.upsert({
          where: { id: 'u1' },
          create: { id: 'u1', email: 'u1@example.com' },
          update: { name: 'Cid' },
          select: { id: true },
        }),
      );

      expect(result).toEqual({ id: 'u1' });
      const record = await recordOf('User', 'u1');
      expect(record?.action).toBe('update');
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Cid' } });
    });

    it('records the row an upsert creates whole, and returns the selected fields', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.upsert({
          where: { id: 'u2' },
          create: { id: 'u2', email: 'u2@example.com', name: 'Dee' },
          update: { name: 'Eve' },
          select: { id: true },
        }),
      );

      expect(result).toEqual({ id: 'u2' });
      const record = await recordOf('User', 'u2');
      expect(record?.action).toBe('create');
      expect(record?.before).toBeNull();
      expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
      expect(record?.after).toMatchObject({ id: 'u2', email: 'u2@example.com', name: 'Dee' });
    });

    it('resolves the aggregate a created row names by a foreign key the caller does not select', async () => {
      const { prisma, run, aggregatesOf, recordOf } = await setup();

      const result = await run(() =>
        prisma.post.create({ data: { id: 'p-new', title: 'New', authorId: 'u1' }, select: { id: true } }),
      );

      expect(result).toEqual({ id: 'p-new' });
      expect(await aggregatesOf('Post')).toEqual(['p-new:Post:p-new', 'p-new:User:u1']);
      expect(keysOf((await recordOf('Post', 'p-new'))?.after)).toEqual(POST_COLUMNS);
    });

    it('records a deleted row under the aggregate its foreign key names, and returns the selected fields', async () => {
      const { prisma, run, aggregatesOf } = await setup();

      const result = await run(() => prisma.post.delete({ where: { id: 'p1' }, select: { id: true } }));

      expect(result).toEqual({ id: 'p1' });
      expect(await aggregatesOf('Post')).toEqual(['p1:Post:p1', 'p1:User:u1']);
    });

    it('records only the columns a limited updateManyAndReturn changed, and returns the selected fields of each row', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.post.create({ data: { id: 'p2', title: 'T2', authorId: 'u1' } });

      const result = await run(() =>
        prisma.post.updateManyAndReturn({
          where: { authorId: 'u1' },
          data: { published: true },
          limit: 2,
          select: { id: true },
        }),
      );

      expect(result.map((row) => keysOf(row))).toEqual([['id'], ['id']]);
      expect(result.map((row) => row.id).sort()).toEqual(['p1', 'p2']);
      const records = await recordsOf('Post');
      expect(records.map((record) => record.changes)).toEqual([
        { published: { old: false, new: true } },
        { published: { old: false, new: true } },
      ]);
    });

    it('records the columns of a row whose select names a written relation only', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { name: 'Dee', posts: { create: { id: 'p-new', title: 'New' } } },
          select: { posts: true },
        }),
      );

      expect(keysOf(result)).toEqual(['posts']);
      expect(result.posts.map((post) => keysOf(post))).toEqual([POST_COLUMNS, POST_COLUMNS]);
      expect((await recordOf('User', 'u1'))?.changes).toEqual({ name: { old: 'Ada', new: 'Dee' } });
      expect((await recordOf('Post', 'p-new'))?.action).toBe('create');
    });
  });

  describe('an omit', () => {
    it('records a change of a field the caller omits, and leaves it out of the result', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { name: 'Eve' }, omit: { name: true } }),
      );

      expect(keysOf(result)).toEqual(USER_COLUMNS.filter((column) => column !== 'name'));
      expect((await recordOf('User', 'u1'))?.changes).toEqual({ name: { old: 'Ada', new: 'Eve' } });
    });

    it('records only the changed columns of a nested row whose relation the caller reads with an omit', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { posts: { update: { where: { id: 'p1' }, data: { title: 'T1b' } } } },
          include: { posts: { omit: { content: true } } },
        }),
      );

      expect(keysOf(result)).toEqual([...USER_COLUMNS, 'posts'].sort());
      expect(result.posts.map((post) => keysOf(post))).toEqual([POST_COLUMNS.filter((column) => column !== 'content')]);
      expect((await recordOf('Post', 'p1'))?.changes).toEqual({ title: { old: 'T1', new: 'T1b' } });
    });
  });

  describe('a relation whose foreign key references a non-key unique field', () => {
    it("records a row created below a parent the caller's select reads without that field", async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.subscription.create({ data: { id: 's-kept', topic: 'kept', userEmail: 'u1@example.com' } });

      const result = await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { subscriptions: { create: { id: 's-new', topic: 'new' } } },
          select: { id: true, subscriptions: { where: { topic: 'kept' } } },
        }),
      );

      expect(keysOf(result)).toEqual(['id', 'subscriptions']);
      expect(result.subscriptions.map((subscription) => keysOf(subscription))).toEqual([
        ['createdAt', 'id', 'topic', 'userEmail'],
      ]);
      expect(result.subscriptions.map((subscription) => subscription.id)).toEqual(['s-kept']);
      const records = await recordsOf('Subscription');
      expect(records.map((record) => `${record.entityId}:${record.action}`)).toEqual(['s-new:create']);
      expect(records[0]?.after).toMatchObject({ topic: 'new', userEmail: 'u1@example.com' });
    });
  });
});
