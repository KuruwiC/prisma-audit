/**
 * Integration Tests: which writes the audit covers, and `requireContext`
 *
 * Whether an operation is audited is decided by the audited models it writes rows of, its own and
 * those of its nested writes, read from the arguments that reach the audit extension. An audited
 * row a nested write writes is recorded even below a model that is not in `entities`. Without an
 * audit context, an operation that writes a model `requireContext` holds for is rejected with
 * `AuditContextMissingError` before Prisma runs any of it; any other runs unaudited.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { EntityMap, PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
import { AuditContextMissingError, createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'require-context-actor' },
};

const postEntity = defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] });
const userEntity = defineEntity({ type: 'User' });

/** Post audited, User not */
const postOnly: EntityMap = { Post: postEntity };
const userAndPost: EntityMap = { User: userEntity, Post: postEntity };

/** Adds a nested create of a Post to the data of every `user.update` */
const addsNestedPost = (name: string) =>
  Prisma.defineExtension({
    name,
    query: {
      user: {
        async update({ args, query }) {
          return query({ ...args, data: { ...args.data, posts: { create: { title: `added by ${name}` } } } });
        },
      },
    },
  });

interface ClientOptions {
  readonly entities: EntityMap;
  readonly requireContext?: PrismaAuditExtensionOptions['requireContext'];
  readonly samplingRate?: number;
  readonly implicitTransaction?: boolean;
  /** Where an extension that adds a nested Post create to every `user.update` sits */
  readonly addsNestedPost?: 'before the audit' | 'after the audit';
}

describe('audit coverage by the audited models a write writes', () => {
  const disposers: Array<() => Promise<void>> = [];
  let raw: PrismaClient;

  beforeAll(() => {
    raw = createBasePrisma();
  });

  afterAll(async () => {
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
    await raw.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(raw);
  });

  const createClient = (options: ClientOptions) => {
    const base = createBasePrisma();
    disposers.push(() => base.$disconnect());
    const provider = createAsyncLocalStorageProvider();
    const audited = createAuditClient(
      options.addsNestedPost === 'before the audit' ? base.$extends(addsNestedPost('before')) : base,
      {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: options.entities,
        requireContext: options.requireContext,
        samplingRate: options.samplingRate,
        write: { awaited: true, implicitTransaction: options.implicitTransaction ?? false },
      },
    );
    const client = options.addsNestedPost === 'after the audit' ? audited.$extends(addsNestedPost('after')) : audited;
    const withContext = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
    return { client, withContext };
  };

  const seedUser = (email = 'owner@example.com') => raw.user.create({ data: { email, name: 'Owner' } });

  /** Every user with its posts, every post with its categories, every profile, and the number of audit logs */
  const databaseState = async () => ({
    users: await raw.user.findMany({ orderBy: { email: 'asc' }, include: { posts: { orderBy: { title: 'asc' } } } }),
    posts: await raw.post.findMany({ orderBy: { title: 'asc' }, include: { categories: true } }),
    profiles: await raw.profile.findMany(),
    auditLogs: await raw.auditLog.count(),
  });

  /** The audit logs of `entityType` under its self aggregate: one per row it records */
  const auditLogsOf = (entityType: string) =>
    raw.auditLog.findMany({ where: { entityType, aggregateType: entityType }, orderBy: { createdAt: 'asc' } });

  describe('an audited row a nested write writes below a model that is not audited', () => {
    it('records the Post a nested create of a user.create writes, and not the User, when entities hold Post and not User', async () => {
      const { client, withContext } = createClient({ entities: postOnly });

      const user = await withContext(() =>
        client.user.create({
          data: { email: 'parent@example.com', name: 'Parent', posts: { create: { title: 'child' } } },
          include: { posts: true },
        }),
      );

      expect(await auditLogsOf('User')).toEqual([]);
      const postLogs = await auditLogsOf('Post');
      expect(postLogs.map(({ action, entityId }) => ({ action, entityId }))).toEqual([
        { action: 'create', entityId: user.posts[0]?.id },
      ]);
      expect(postLogs[0]?.after).toMatchObject({ title: 'child', authorId: user.id });
    });

    it('resolves the to() aggregate of a Post a nested write writes below a User that is not audited', async () => {
      const { client, withContext } = createClient({ entities: postOnly });

      const user = await withContext(() =>
        client.user.create({
          data: { email: 'aggregate@example.com', name: 'Parent', posts: { create: { title: 'child' } } },
          include: { posts: true },
        }),
      );

      const roots = (await raw.auditLog.findMany({ where: { entityType: 'Post' } })).map(
        ({ aggregateType, aggregateId }) => ({ aggregateType, aggregateId }),
      );
      expect(roots).toEqual(
        expect.arrayContaining([
          { aggregateType: 'Post', aggregateId: user.posts[0]?.id },
          { aggregateType: 'User', aggregateId: user.id },
        ]),
      );
      expect(roots).toHaveLength(2);
    });

    it('records the Post a nested update of a user.update writes, and not the User, when entities hold Post and not User', async () => {
      const user = await seedUser();
      const post = await raw.post.create({ data: { title: 'before', authorId: user.id } });
      const { client, withContext } = createClient({ entities: postOnly });

      await withContext(() =>
        client.user.update({
          where: { id: user.id },
          data: { name: 'Renamed', posts: { update: { where: { id: post.id }, data: { title: 'after' } } } },
        }),
      );

      expect(await auditLogsOf('User')).toEqual([]);
      const postLogs = await auditLogsOf('Post');
      expect(postLogs.map(({ action, entityId }) => ({ action, entityId }))).toEqual([
        { action: 'update', entityId: post.id },
      ]);
      expect(postLogs[0]?.changes).toMatchObject({ title: { old: 'before', new: 'after' } });
    });

    it("records as created only the Post the update branch of a user.upsert on an existing User writes, not the create branch's or the existing child, when entities hold Post and not User", async () => {
      const user = await seedUser();
      const existing = await raw.post.create({ data: { title: 'existing', authorId: user.id } });
      const { client, withContext } = createClient({ entities: postOnly });

      await withContext(() =>
        client.user.upsert({
          where: { id: user.id },
          create: { email: 'never@example.com', posts: { create: { title: 'create branch' } } },
          update: { name: 'Upserted', posts: { create: { title: 'update branch' } } },
        }),
      );

      const posts = await raw.post.findMany({ where: { authorId: user.id } });
      const added = posts.find((post) => post.title === 'update branch');
      expect(posts.map((post) => post.title).sort()).toEqual(['existing', 'update branch']);
      expect(await auditLogsOf('User')).toEqual([]);
      const postLogs = await auditLogsOf('Post');
      expect(postLogs.map(({ action, entityId }) => ({ action, entityId }))).toEqual([
        { action: 'create', entityId: added?.id },
      ]);
      expect(postLogs.some((log) => log.entityId === existing.id)).toBe(false);
    });
  });

  describe('requireContext', () => {
    const rejectsUnchanged = async (operation: () => Promise<unknown>, modelName: string) => {
      const before = await databaseState();

      await expect(operation()).rejects.toBeInstanceOf(AuditContextMissingError);
      await expect(operation()).rejects.toMatchObject({ modelName });
      expect(await databaseState()).toEqual(before);
    };

    describe('rejects a write without an audit context to a model it holds for', () => {
      const operations: ReadonlyArray<
        readonly [string, (client: ReturnType<typeof createClient>['client'], userId: string) => Promise<unknown>]
      > = [
        ['create', (client) => client.user.create({ data: { email: 'new@example.com' } })],
        ['update', (client, id) => client.user.update({ where: { id }, data: { name: 'Changed' } })],
        ['delete', (client, id) => client.user.delete({ where: { id } })],
        [
          'upsert',
          (client, id) =>
            client.user.upsert({ where: { id }, create: { email: 'new@example.com' }, update: { name: 'Changed' } }),
        ],
        ['createMany', (client) => client.user.createMany({ data: [{ email: 'new@example.com' }] })],
        ['updateMany', (client) => client.user.updateMany({ data: { name: 'Changed' } })],
        ['deleteMany', (client) => client.user.deleteMany()],
      ];

      it.each(operations)(
        'rejects a %s with AuditContextMissingError, leaving the database unchanged',
        async (_operation, run) => {
          const user = await seedUser();
          const { client } = createClient({ entities: userAndPost, requireContext: true });

          await rejectsUnchanged(() => run(client, user.id), 'User');
        },
      );
    });

    it.each([
      ['User and Post', userAndPost],
      ['Post and not User', postOnly],
    ])(
      'rejects without an audit context a user.create whose nested create writes a Post, requireContext holding for Post only and entities holding %s, leaving the database unchanged',
      async (_entities, entities) => {
        const { client } = createClient({ entities, requireContext: (modelName) => modelName === 'Post' });

        await rejectsUnchanged(
          () => client.user.create({ data: { email: 'parent@example.com', posts: { create: { title: 'child' } } } }),
          'Post',
        );
      },
    );

    describe('a nested link change, by the side of the foreign key', () => {
      it('runs without an audit context a post.create that connects its author, requireContext holding for User only, since it writes no User row', async () => {
        const user = await seedUser();
        const { client } = createClient({ entities: userAndPost, requireContext: (modelName) => modelName === 'User' });

        await client.post.create({ data: { title: 'connected', author: { connect: { id: user.id } } } });

        expect(await raw.post.count({ where: { authorId: user.id } })).toBe(1);
        expect(await raw.auditLog.count()).toBe(0);
      });

      it('rejects without an audit context a user.update that connects a Post, requireContext holding for Post, since the connect writes the Post foreign key', async () => {
        const owner = await seedUser();
        const other = await seedUser('other@example.com');
        const post = await raw.post.create({ data: { title: 'moved', authorId: other.id } });
        const { client } = createClient({ entities: userAndPost, requireContext: (modelName) => modelName === 'Post' });

        await rejectsUnchanged(
          () => client.user.update({ where: { id: owner.id }, data: { posts: { connect: { id: post.id } } } }),
          'Post',
        );
      });

      it('runs without an audit context a connect through an implicit many-to-many relation, requireContext holding for the related model only, since it writes only the join table', async () => {
        const user = await seedUser();
        const post = await raw.post.create({ data: { title: 'tagged', authorId: user.id } });
        const category = await raw.category.create({ data: { name: 'news' } });
        const { client } = createClient({
          entities: { ...userAndPost, Category: defineEntity({ type: 'Category' }) },
          requireContext: (modelName) => modelName === 'Category',
        });

        await client.post.update({ where: { id: post.id }, data: { categories: { connect: { id: category.id } } } });

        expect(await raw.category.count({ where: { posts: { some: { id: post.id } } } })).toBe(1);
      });

      it('rejects without an audit context a connect through an implicit many-to-many relation, requireContext holding for the model the operation is called on', async () => {
        const user = await seedUser();
        const post = await raw.post.create({ data: { title: 'tagged', authorId: user.id } });
        const category = await raw.category.create({ data: { name: 'news' } });
        const { client } = createClient({ entities: userAndPost, requireContext: (modelName) => modelName === 'Post' });

        await rejectsUnchanged(
          () => client.post.update({ where: { id: post.id }, data: { categories: { connect: { id: category.id } } } }),
          'Post',
        );
      });
    });

    it('runs without an audit context nested values that write no row (delete: false, disconnect: false, create: []), requireContext holding for their models', async () => {
      const user = await seedUser();
      await raw.profile.create({ data: { userId: user.id, bio: 'kept' } });
      const { client } = createClient({
        entities: { ...userAndPost, Profile: defineEntity({ type: 'Profile' }) },
        requireContext: (modelName) => modelName !== 'User',
      });

      await client.user.update({
        where: { id: user.id },
        data: { name: 'Changed', profile: { delete: false, disconnect: false }, posts: { create: [] } },
      });

      expect(await raw.user.findUnique({ where: { id: user.id } })).toMatchObject({ name: 'Changed' });
      expect(await raw.profile.count({ where: { userId: user.id } })).toBe(1);
    });

    it('rejects without an audit context a nested set: [], which unlinks every related row, requireContext holding for its model', async () => {
      const user = await seedUser();
      await raw.label.create({ data: { name: 'linked' } });
      const { client } = createClient({
        entities: { ...userAndPost, Label: defineEntity({ type: 'Label' }) },
        requireContext: (modelName) => modelName === 'Label',
      });
      const post = await raw.post.create({ data: { title: 'labelled', authorId: user.id } });
      await raw.label.updateMany({ data: { postId: post.id } });

      await rejectsUnchanged(
        () => client.post.update({ where: { id: post.id }, data: { labels: { set: [] } } }),
        'Label',
      );
    });

    it('rejects without an audit context, with implicitTransaction, a user.update to which an extension applied before the audit adds a nested Post create, requireContext holding for Post', async () => {
      const user = await seedUser();
      const { client } = createClient({
        entities: userAndPost,
        requireContext: (modelName) => modelName === 'Post',
        implicitTransaction: true,
        addsNestedPost: 'before the audit',
      });

      await rejectsUnchanged(() => client.user.update({ where: { id: user.id }, data: { name: 'Changed' } }), 'Post');
    });

    it('runs unaudited, without an audit context, a write of a model the requireContext function is false for, writing the row and no audit log', async () => {
      const { client } = createClient({ entities: userAndPost, requireContext: (modelName) => modelName === 'Post' });

      await client.user.create({ data: { email: 'free@example.com' } });

      expect(await raw.user.count()).toBe(1);
      expect(await raw.auditLog.count()).toBe(0);
    });

    it('rejects without an audit context, with implicitTransaction, a create of a model it holds for, leaving the database unchanged', async () => {
      const { client } = createClient({ entities: userAndPost, requireContext: true, implicitTransaction: true });

      await rejectsUnchanged(() => client.user.create({ data: { email: 'new@example.com' } }), 'User');
    });

    it.each([true, false])(
      'rejects without an audit context a batch $transaction([...]) whose second operation writes a model it holds for, leaving the database unchanged (implicitTransaction: %s)',
      async (implicitTransaction) => {
        const user = await seedUser();
        const { client } = createClient({
          entities: userAndPost,
          requireContext: (modelName) => modelName === 'Post',
          implicitTransaction,
        });
        const before = await databaseState();

        await expect(
          client.$transaction([
            client.user.create({ data: { email: 'batched@example.com' } }),
            client.post.create({ data: { title: 'batched', authorId: user.id } }),
          ]),
        ).rejects.toBeInstanceOf(AuditContextMissingError);
        expect(await databaseState()).toEqual(before);
      },
    );

    it('rejects without an audit context a write of a model it holds for at a samplingRate of 0', async () => {
      const { client } = createClient({ entities: userAndPost, requireContext: true, samplingRate: 0 });

      await rejectsUnchanged(() => client.user.create({ data: { email: 'new@example.com' } }), 'User');
    });

    it('runs a write without an audit context unaudited when requireContext is not set', async () => {
      const { client } = createClient({ entities: userAndPost });

      await client.user.create({ data: { email: 'default@example.com', posts: { create: { title: 'child' } } } });

      expect(await raw.user.count()).toBe(1);
      expect(await raw.post.count()).toBe(1);
      expect(await raw.auditLog.count()).toBe(0);
    });

    describe('documented limitation: the audit sees only the arguments that reach it', () => {
      it('runs without an audit context a user.update to which an extension applied after the audit adds a nested Post create, requireContext holding for Post', async () => {
        const user = await seedUser();
        const { client } = createClient({
          entities: userAndPost,
          requireContext: (modelName) => modelName === 'Post',
          addsNestedPost: 'after the audit',
        });

        await client.user.update({ where: { id: user.id }, data: { name: 'Changed' } });

        expect(await raw.post.findMany({ where: { authorId: user.id } })).toEqual([
          expect.objectContaining({ title: 'added by after' }),
        ]);
        expect(await raw.auditLog.count()).toBe(0);
      });
    });
  });
});
