/**
 * Integration Test: foreign-key changes of related rows
 *
 * On a relation whose foreign key lives on the related model, a nested `connect`, `set`,
 * `disconnect` or a `connectOrCreate` that connects rewrites the foreign key of existing related
 * rows. Each row whose foreign key changed is audited as an `update` of that row, whose `changes`
 * tell where it was attached before and after. A relation whose foreign key lives on the parent
 * row is audited by the parent's own update, and an implicit many-to-many relation only changes
 * rows of Prisma's join table, which has no model.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping, AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'link-changes-actor' },
};

interface SetupOptions {
  readonly aggregateMapping?: AggregateMapping;
  readonly fetchBeforeLabelUpdate?: boolean;
  /** The first `findMany` of this model made after `arm()` fails */
  readonly faultModel?: 'Label';
}

describe('foreign-key changes of related rows', () => {
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

  const setup = async (options: SetupOptions = {}) => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let armed = false;
    const faultyPrisma = basePrisma.$extends({
      name: 'fault-injection',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (armed && model === options.faultModel && operation === 'findMany') {
              armed = false;
              throw new Error(`simulated ${model}.${operation} failure`);
            }
            return query(args);
          },
        },
      },
    });
    const observer = vi.fn<AuditErrorObserver>();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(faultyPrisma, {
      Prisma,
      provider,
      aggregateMapping: options.aggregateMapping ?? testAggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      security: { redact: { fields: [] } },
      fetchBefore: {
        update: true,
        delete: true,
        models: options.fetchBeforeLabelUpdate === false ? { Label: { update: false } } : {},
      },
      errorHandling: { observer },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const arm = () => {
      armed = true;
    };
    const phases = () => observer.mock.calls.map(([context]) => [context.phase, context.modelName, context.operation]);
    /** The records of `entityType` (its own aggregate row), sorted by entity id */
    const recordsOf = async (entityType: string) =>
      (
        await basePrisma.auditLog.findMany({
          where: { entityType, aggregateType: entityType },
          select: { entityId: true, action: true, changes: true, after: true, beforeUnavailable: true },
          orderBy: { entityId: 'asc' },
        })
      ).map((log) => ({
        id: log.entityId,
        action: log.action,
        changes: log.changes as Record<string, { old?: unknown; new?: unknown }> | null,
        after: log.after as Record<string, unknown> | null,
        beforeUnavailable: log.beforeUnavailable,
      }));

    await basePrisma.user.create({ data: { id: 'u1', email: 'ada@example.com', name: 'Ada' } });
    await basePrisma.user.create({ data: { id: 'u2', email: 'ben@example.com', name: 'Ben' } });
    await basePrisma.post.create({ data: { id: 'p-live', title: 'Live', published: true, authorId: 'u1' } });
    await basePrisma.post.create({ data: { id: 'p-draft', title: 'Draft', authorId: 'u1' } });
    await basePrisma.post.create({ data: { id: 'p-u2', title: 'Other', authorId: 'u2' } });

    return { basePrisma, prisma, run, arm, phases, recordsOf };
  };

  describe('a to-many relation', () => {
    it('audits a connected row that moves from another parent with its foreign key old and new', async () => {
      const { prisma, run, recordsOf } = await setup();

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { posts: { connect: { id: 'p-u2' } } } }));

      const records = await recordsOf('Post');
      expect(records.map(({ id, action }) => [id, action])).toEqual([['p-u2', 'update']]);
      expect(records[0]?.changes).toMatchObject({ authorId: { old: 'u2', new: 'u1' } });
    });

    it('audits a disconnected row with its foreign key set to null', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p-live' } });

      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { labels: { disconnect: { id: 'l1' } } } }));

      expect(await recordsOf('Label')).toEqual([
        expect.objectContaining({ id: 'l1', action: 'update', changes: { postId: { old: 'p-live', new: null } } }),
      ]);
    });

    it('audits nothing for a disconnect of a row attached to another parent', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.label.create({ data: { id: 'l2', name: 'l2', postId: 'p-u2' } });

      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { labels: { disconnect: { id: 'l2' } } } }));

      expect(await recordsOf('Label')).toEqual([]);
      expect(await basePrisma.label.findUnique({ where: { id: 'l2' } })).toMatchObject({ postId: 'p-u2' });
    });

    it('audits the rows a set detaches and the rows it moves in, not the rows it keeps', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p-live' } });
      await basePrisma.label.create({ data: { id: 'l2', name: 'l2', postId: 'p-live' } });
      await basePrisma.label.create({ data: { id: 'l3', name: 'l3', postId: 'p-u2' } });

      await run(() =>
        prisma.post.update({ where: { id: 'p-live' }, data: { labels: { set: [{ id: 'l2' }, { id: 'l3' }] } } }),
      );

      expect(await recordsOf('Label')).toEqual([
        expect.objectContaining({ id: 'l1', action: 'update', changes: { postId: { old: 'p-live', new: null } } }),
        expect.objectContaining({ id: 'l3', action: 'update', changes: { postId: { old: 'p-u2', new: 'p-live' } } }),
      ]);
    });

    it('audits the row a connectOrCreate connects from another parent', async () => {
      const { prisma, run, recordsOf } = await setup();

      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { posts: { connectOrCreate: { where: { id: 'p-u2' }, create: { id: 'p-u2', title: 'Other' } } } },
        }),
      );

      const records = await recordsOf('Post');
      expect(records.map(({ id, action }) => [id, action])).toEqual([['p-u2', 'update']]);
      expect(records[0]?.changes).toMatchObject({ authorId: { old: 'u2', new: 'u1' } });
    });

    it('audits the rows connected under several parent rows at one path, each to its own parent', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.label.create({ data: { id: 'la', name: 'la', postId: 'p-u2' } });
      await basePrisma.label.create({ data: { id: 'lb', name: 'lb', postId: 'p-u2' } });

      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: {
            posts: {
              update: [
                { where: { id: 'p-live' }, data: { labels: { connect: { id: 'la' } } } },
                { where: { id: 'p-draft' }, data: { labels: { connect: { id: 'lb' } } } },
              ],
            },
          },
        }),
      );

      expect(await recordsOf('Label')).toEqual([
        expect.objectContaining({ id: 'la', changes: { postId: { old: 'p-u2', new: 'p-live' } } }),
        expect.objectContaining({ id: 'lb', changes: { postId: { old: 'p-u2', new: 'p-draft' } } }),
      ]);
    });

    it('skips a row whose only change is a foreign key the entity excludes', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup({
        aggregateMapping: {
          ...testAggregateMapping,
          Label: defineEntity({ type: 'Label', excludeFields: ['postId'] }),
        },
      });
      await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p-live' } });

      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { labels: { disconnect: { id: 'l1' } } } }));

      expect(await recordsOf('Label')).toEqual([]);
    });

    it('audits a named row without a before state when the read of the rows failed', async () => {
      const { basePrisma, prisma, run, arm, phases, recordsOf } = await setup({ faultModel: 'Label' });
      await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p-live' } });

      arm();
      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { labels: { disconnect: { id: 'l1' } } } }));

      expect(phases()).toEqual([['pre-fetch', 'Label', 'disconnect']]);
      expect(await recordsOf('Label')).toEqual([
        expect.objectContaining({ id: 'l1', action: 'update', beforeUnavailable: true, changes: null }),
      ]);
      expect((await recordsOf('Label'))[0]?.after).toMatchObject({ postId: null });
    });

    it.each([
      ['connect twice', { connect: [{ id: 'l2' }, { id: 'l2' }] }],
      [
        'connect and connectOrCreate',
        { connect: { id: 'l2' }, connectOrCreate: { where: { id: 'l2' }, create: { id: 'l2', name: 'l2' } } },
      ],
    ])('audits a row two link writes name once when the read of the rows failed (%s)', async (_, labels) => {
      const { basePrisma, prisma, run, arm, phases, recordsOf } = await setup({ faultModel: 'Label' });
      await basePrisma.label.create({ data: { id: 'l2', name: 'l2', postId: 'p-u2' } });

      arm();
      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { labels } }));

      expect(phases()).toEqual([['pre-fetch', 'Label', 'connect']]);
      expect((await recordsOf('Label')).map(({ id, action }) => [id, action])).toEqual([['l2', 'update']]);
    });

    it('keeps the before state a connectOrCreate read when the read of the rows a connect names failed', async () => {
      const { basePrisma, prisma, run, arm, phases, recordsOf } = await setup({ faultModel: 'Label' });
      await basePrisma.label.create({ data: { id: 'l2', name: 'l2', postId: 'p-u2' } });

      arm();
      await run(() =>
        prisma.post.update({
          where: { id: 'p-live' },
          data: {
            labels: {
              connect: { id: 'l2' },
              connectOrCreate: { where: { id: 'l2' }, create: { id: 'l2', name: 'l2' } },
            },
          },
        }),
      );

      expect(phases()).toEqual([['pre-fetch', 'Label', 'connect']]);
      expect(await recordsOf('Label')).toEqual([
        expect.objectContaining({
          id: 'l2',
          action: 'update',
          beforeUnavailable: false,
          changes: { postId: { old: 'p-u2', new: 'p-live' } },
        }),
      ]);
    });

    it('audits a row once when an update under one parent row and a connect under another both write it', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p-draft' } });

      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: {
            posts: {
              update: [
                {
                  where: { id: 'p-draft' },
                  data: { labels: { update: { where: { id: 'l1' }, data: { name: 'renamed' } } } },
                },
                { where: { id: 'p-live' }, data: { labels: { connect: { id: 'l1' } } } },
              ],
            },
          },
        }),
      );

      expect(await recordsOf('Label')).toEqual([
        expect.objectContaining({
          id: 'l1',
          action: 'update',
          changes: { name: { old: 'l1', new: 'renamed' }, postId: { old: 'p-draft', new: 'p-live' } },
        }),
      ]);
    });

    it.each([
      ['already attached to the parent', 'p-live', { name: { old: 'l1', new: 'renamed' } }],
      [
        'attached to another parent',
        'p-u2',
        { name: { old: 'l1', new: 'renamed' }, postId: { old: 'p-u2', new: 'p-live' } },
      ],
    ])(
      'audits a row a connect and an update both name once, with every change, when it is %s',
      async (_, postId, changes) => {
        const { basePrisma, prisma, run, recordsOf } = await setup();
        await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId } });

        await run(() =>
          prisma.post.update({
            where: { id: 'p-live' },
            data: { labels: { connect: { id: 'l1' }, update: { where: { id: 'l1' }, data: { name: 'renamed' } } } },
          }),
        );

        const labels = await recordsOf('Label');
        expect(labels.map(({ id, action }) => [id, action])).toEqual([['l1', 'update']]);
        expect(labels[0]?.changes).toEqual(changes);
      },
    );

    it('audits no foreign-key change when the before state of the related model is not read', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup({ fetchBeforeLabelUpdate: false });
      await basePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: 'p-live' } });

      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { labels: { disconnect: { id: 'l1' } } } }));

      expect(await recordsOf('Label')).toEqual([]);
    });
  });

  describe('a to-one relation', () => {
    it('audits a connected row that moves from another parent', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.profile.create({ data: { id: 'pr2', userId: 'u2', bio: 'b' } });

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { profile: { connect: { id: 'pr2' } } } }));

      const records = await recordsOf('Profile');
      expect(records.map(({ id, action }) => [id, action])).toEqual([['pr2', 'update']]);
      expect(records[0]?.changes).toMatchObject({ userId: { old: 'u2', new: 'u1' } });
    });
  });

  describe('a to-one relation with an optional foreign key', () => {
    const seedBadges = async (basePrisma: PrismaClient) => {
      await basePrisma.badge.create({ data: { id: 'b1', name: 'b1', userId: 'u1' } });
      await basePrisma.badge.create({ data: { id: 'b2', name: 'b2' } });
    };

    it('audits the row a connect replaces as unlinked and the connected row as linked', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await seedBadges(basePrisma);

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { badge: { connect: { id: 'b2' } } } }));

      expect(await recordsOf('Badge')).toEqual([
        expect.objectContaining({ id: 'b1', action: 'update', changes: { userId: { old: 'u1', new: null } } }),
        expect.objectContaining({ id: 'b2', action: 'update', changes: { userId: { old: null, new: 'u1' } } }),
      ]);
    });

    it('audits the row a disconnect unlinks', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await seedBadges(basePrisma);

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { badge: { disconnect: true } } }));

      expect(await recordsOf('Badge')).toEqual([
        expect.objectContaining({ id: 'b1', action: 'update', changes: { userId: { old: 'u1', new: null } } }),
      ]);
    });

    it('audits the row a create replaces as unlinked next to the created row', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await seedBadges(basePrisma);

      await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { badge: { create: { id: 'b-new', name: 'new' } } } }),
      );

      expect(await recordsOf('Badge')).toEqual([
        expect.objectContaining({ id: 'b-new', action: 'create' }),
        expect.objectContaining({ id: 'b1', action: 'update', changes: { userId: { old: 'u1', new: null } } }),
      ]);
    });

    it('audits the row a connectOrCreate replaces and the row it connects', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await seedBadges(basePrisma);

      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { badge: { connectOrCreate: { where: { id: 'b2' }, create: { id: 'b2', name: 'b2' } } } },
        }),
      );

      expect(await recordsOf('Badge')).toEqual([
        expect.objectContaining({ id: 'b1', action: 'update', changes: { userId: { old: 'u1', new: null } } }),
        expect.objectContaining({ id: 'b2', action: 'update', changes: { userId: { old: null, new: 'u1' } } }),
      ]);
    });

    it('audits nothing for a connect of the row already linked', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await seedBadges(basePrisma);

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { badge: { connect: { id: 'b1' } } } }));

      expect(await recordsOf('Badge')).toEqual([]);
    });

    it.each([
      ['already linked to the parent', 'u1', { name: { old: 'b1', new: 'renamed' } }],
      ['linked to another parent', 'u2', { name: { old: 'b1', new: 'renamed' }, userId: { old: 'u2', new: 'u1' } }],
      ['unlinked', null, { name: { old: 'b1', new: 'renamed' }, userId: { old: null, new: 'u1' } }],
    ])(
      'audits a row a connect and an update both name once, with every change, when it is %s',
      async (_, userId, changes) => {
        const { basePrisma, prisma, run, recordsOf } = await setup();
        await basePrisma.badge.create({ data: { id: 'b1', name: 'b1', userId } });

        await run(() =>
          prisma.user.update({
            where: { id: 'u1' },
            data: { badge: { connect: { id: 'b1' }, update: { name: 'renamed' } } },
          }),
        );

        const badges = await recordsOf('Badge');
        expect(badges.map(({ id, action }) => [id, action])).toEqual([['b1', 'update']]);
        expect(badges[0]?.changes).toEqual(changes);
      },
    );
  });

  describe('a relation without a foreign key on the related model', () => {
    it("audits a connect on the parent's own foreign key as the parent's update only", async () => {
      const { prisma, run, recordsOf } = await setup();

      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { author: { connect: { id: 'u2' } } } }));

      const posts = await recordsOf('Post');
      expect(posts.map(({ id, action }) => [id, action])).toEqual([['p-live', 'update']]);
      expect(posts[0]?.changes).toEqual({ authorId: { old: 'u1', new: 'u2' } });
      expect(await recordsOf('User')).toEqual([]);
    });

    it.each([
      ['an update', { update: { name: 'Ben renamed' } }],
      [
        'an upsert',
        { upsert: { create: { id: 'u-new', email: 'new@example.com', name: 'New' }, update: { name: 'Ben renamed' } } },
      ],
    ])('audits the row a connect and %s both name as the update of the connected row', async (_, write) => {
      const { prisma, run, recordsOf } = await setup();

      await run(() =>
        prisma.post.update({ where: { id: 'p-live' }, data: { author: { connect: { id: 'u2' }, ...write } } }),
      );

      const posts = await recordsOf('Post');
      expect(posts.map(({ id, action }) => [id, action])).toEqual([['p-live', 'update']]);
      expect(posts[0]?.changes).toEqual({ authorId: { old: 'u1', new: 'u2' } });
      const users = await recordsOf('User');
      expect(users.map(({ id, action }) => [id, action])).toEqual([['u2', 'update']]);
      expect(users[0]?.changes).toEqual({ name: { old: 'Ben', new: 'Ben renamed' } });
    });

    it('audits the row a connectOrCreate names and an update writes as the update of that row', async () => {
      const { prisma, run, recordsOf } = await setup();

      await run(() =>
        prisma.post.update({
          where: { id: 'p-live' },
          data: {
            author: {
              connectOrCreate: { where: { id: 'u2' }, create: { id: 'u2', email: 'ben@example.com' } },
              update: { name: 'Ben renamed' },
            },
          },
        }),
      );

      const posts = await recordsOf('Post');
      expect(posts.map(({ id, action }) => [id, action])).toEqual([['p-live', 'update']]);
      expect(posts[0]?.changes).toEqual({ authorId: { old: 'u1', new: 'u2' } });
      const users = await recordsOf('User');
      expect(users.map(({ id, action }) => [id, action])).toEqual([['u2', 'update']]);
      expect(users[0]?.changes).toEqual({ name: { old: 'Ben', new: 'Ben renamed' } });
    });

    it('audits the row a connectOrCreate creates and an update writes as created, without the previously linked row', async () => {
      const { prisma, run, recordsOf } = await setup();

      await run(() =>
        prisma.post.update({
          where: { id: 'p-live' },
          data: {
            author: {
              connectOrCreate: {
                where: { id: 'u-new' },
                create: { id: 'u-new', email: 'new@example.com', name: 'New' },
              },
              update: { name: 'New renamed' },
            },
          },
        }),
      );

      const users = await recordsOf('User');
      expect(users.map(({ id, action }) => [id, action])).toEqual([['u-new', 'create']]);
      expect(users[0]?.after).toMatchObject({ id: 'u-new', name: 'New renamed' });
    });

    it('audits nothing for a connect through an implicit many-to-many relation', async () => {
      const { basePrisma, prisma, run, recordsOf } = await setup();
      await basePrisma.category.create({ data: { id: 'c1', name: 'news' } });

      await run(() => prisma.post.update({ where: { id: 'p-live' }, data: { categories: { connect: { id: 'c1' } } } }));

      expect(await recordsOf('Category')).toEqual([]);
      expect(
        await basePrisma.post.findUnique({ where: { id: 'p-live' }, select: { categories: { select: { id: true } } } }),
      ).toEqual({ categories: [{ id: 'c1' }] });
    });
  });
});
