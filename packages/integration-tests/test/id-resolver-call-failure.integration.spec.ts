/**
 * Integration Test: a failing id resolver is reported, and only what depends on it is not audited
 *
 * A resolver that throws never fails the caller's write. The observer hears about it once per
 * affected row with `phase: 'id-resolver-call'`: an entity `idResolver` failure leaves the row
 * without any audit log entry, a `to()` resolver failure leaves it without the entry under that
 * aggregate root only.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, defineEntity, foreignKey, lookup, to } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregatesOf,
  cleanDatabase,
  createBasePrisma,
  createTestContext,
  disposeTestContext,
  type TestContext,
  testAggregateMapping,
} from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'id-resolver-call-actor' },
};

const BROKEN_TITLE = 'broken';

describe('id-resolver-call failures', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const createClient = (post: ReturnType<typeof defineEntity>, observer: AuditErrorObserver) => {
    const basePrisma = createBasePrisma(context.databaseUrl);
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: { ...testAggregateMapping, Post: post },
      performance: { awaitWrite: true },
      errorHandling: { observer },
    });
    return { basePrisma, provider, prisma };
  };

  const createAuthor = () =>
    context.provider.runAsync(testActor, async () =>
      context.prisma.user.create({ data: { email: 'id-resolver-call@example.com', name: 'Author' } }),
    );

  const postIdsByTitle = async (authorId: string): Promise<Record<string, string>> => {
    const posts = await context.basePrisma.post.findMany({ where: { authorId }, select: { id: true, title: true } });
    return Object.fromEntries(posts.map((post) => [post.title, post.id]));
  };

  const postLogs = () =>
    context.basePrisma.auditLog.findMany({
      where: { entityType: 'Post' },
      select: { entityId: true, aggregateType: true },
      orderBy: [{ entityId: 'asc' }, { aggregateType: 'asc' }],
    });

  it("an entity idResolver throwing for one row of a batch skips that row's entries, reports it, and the write succeeds", async () => {
    const resolverError = new Error('entity id resolver is broken');
    const observer = vi.fn<AuditErrorObserver>();
    const { basePrisma, provider, prisma } = createClient(
      defineEntity({
        type: 'Post',
        idResolver: async (post) => {
          if (post.title === BROKEN_TITLE) throw resolverError;
          return post.id as string;
        },
        aggregates: [to('User', foreignKey('authorId'))],
      }),
      observer,
    );

    try {
      const author = await createAuthor();

      await expect(
        provider.runAsync(testActor, async () =>
          prisma.post.createMany({
            data: [
              { title: 'ok', authorId: author.id },
              { title: BROKEN_TITLE, authorId: author.id },
            ],
          }),
        ),
      ).resolves.toEqual({ count: 2 });

      const ids = await postIdsByTitle(author.id);
      expect(Object.keys(ids).sort()).toEqual([BROKEN_TITLE, 'ok']);
      expect(await postLogs()).toEqual([
        { entityId: ids.ok, aggregateType: 'Post' },
        { entityId: ids.ok, aggregateType: 'User' },
      ]);
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith({
        phase: 'id-resolver-call',
        modelName: 'Post',
        operation: 'createMany',
        params: { identity: ids[BROKEN_TITLE], resolver: { kind: 'entity' } },
        error: resolverError,
      });
    } finally {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    }
  });

  describe('an entity idResolver throwing in a write of one record', () => {
    const resolverError = new Error('entity id resolver is broken');

    const createBrokenIdClient = (observer: AuditErrorObserver) =>
      createClient(
        defineEntity({
          type: 'Post',
          idResolver: async (post) => {
            if (post.title === BROKEN_TITLE) throw resolverError;
            return post.id as string;
          },
          aggregates: [to('User', foreignKey('authorId'))],
        }),
        observer,
      );

    it('a create is persisted, gets no entry, and is reported once', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, provider, prisma } = createBrokenIdClient(observer);

      try {
        const author = await createAuthor();

        const created = await provider.runAsync(testActor, async () =>
          prisma.post.create({ data: { title: BROKEN_TITLE, authorId: author.id } }),
        );

        expect(await context.basePrisma.post.findMany({ select: { id: true } })).toEqual([{ id: created.id }]);
        expect(await postLogs()).toEqual([]);
        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith({
          phase: 'id-resolver-call',
          modelName: 'Post',
          operation: 'create',
          params: { identity: created.id, resolver: { kind: 'entity' } },
          error: resolverError,
        });
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('an update is persisted, gets no entry, and is reported once', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, provider, prisma } = createBrokenIdClient(observer);

      try {
        const author = await createAuthor();
        const post = await context.basePrisma.post.create({ data: { title: 'ok', authorId: author.id } });

        const updated = await provider.runAsync(testActor, async () =>
          prisma.post.update({ where: { id: post.id }, data: { title: BROKEN_TITLE } }),
        );

        expect(updated.title).toBe(BROKEN_TITLE);
        expect((await context.basePrisma.post.findUnique({ where: { id: post.id } }))?.title).toBe(BROKEN_TITLE);
        expect(await postLogs()).toEqual([]);
        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith({
          phase: 'id-resolver-call',
          modelName: 'Post',
          operation: 'update',
          params: { identity: post.id, resolver: { kind: 'entity' } },
          error: resolverError,
        });
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a nested create skips the failing row, keeps its sibling and the parent update, and reports once', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, provider, prisma } = createBrokenIdClient(observer);

      try {
        const author = await createAuthor();

        await provider.runAsync(testActor, async () =>
          prisma.user.update({
            where: { id: author.id },
            data: {
              name: 'Renamed',
              posts: { create: [{ title: 'ok' }, { title: BROKEN_TITLE }] },
            },
          }),
        );

        const ids = await postIdsByTitle(author.id);
        expect(Object.keys(ids).sort()).toEqual([BROKEN_TITLE, 'ok']);
        expect(await postLogs()).toEqual([
          { entityId: ids.ok, aggregateType: 'Post' },
          { entityId: ids.ok, aggregateType: 'User' },
        ]);
        const userUpdates = await context.basePrisma.auditLog.findMany({
          where: { entityType: 'User', entityId: author.id, action: 'update' },
          select: { aggregateType: true, aggregateId: true },
        });
        expect(userUpdates).toEqual([{ aggregateType: 'User', aggregateId: author.id }]);
        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith({
          phase: 'id-resolver-call',
          modelName: 'Post',
          operation: 'create',
          params: { identity: ids[BROKEN_TITLE], resolver: { kind: 'entity' } },
          error: resolverError,
        });
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });
  });

  it("a to() resolver throwing for one row skips only that row's entry under the aggregate, reports it, and the write succeeds", async () => {
    const resolverError = new Error('aggregate resolver is broken');
    const observer = vi.fn<AuditErrorObserver>();
    const { basePrisma, provider, prisma } = createClient(
      defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            lookup(async (post: Record<string, unknown>) => {
              if (post.title === BROKEN_TITLE) throw resolverError;
              return post.authorId as string;
            }),
          ),
        ],
      }),
      observer,
    );

    try {
      const author = await createAuthor();

      await expect(
        provider.runAsync(testActor, async () =>
          prisma.post.createMany({
            data: [
              { title: 'ok', authorId: author.id },
              { title: BROKEN_TITLE, authorId: author.id },
            ],
          }),
        ),
      ).resolves.toEqual({ count: 2 });

      const ids = await postIdsByTitle(author.id);
      const expectedLogs = [
        { entityId: ids.ok, aggregateType: 'Post' },
        { entityId: ids.ok, aggregateType: 'User' },
        { entityId: ids[BROKEN_TITLE], aggregateType: 'Post' },
      ].sort((a, b) => `${a.entityId}:${a.aggregateType}`.localeCompare(`${b.entityId}:${b.aggregateType}`));
      expect(await postLogs()).toEqual(expectedLogs);
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith({
        phase: 'id-resolver-call',
        modelName: 'Post',
        operation: 'createMany',
        params: {
          identity: ids[BROKEN_TITLE],
          resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' },
        },
        error: resolverError,
      });
    } finally {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    }
  });

  describe('a foreignKey root and the columns of the row', () => {
    const createClientWith = (fetchBeforeDelete: boolean, observer: AuditErrorObserver) => {
      const basePrisma = createBasePrisma(context.databaseUrl);
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        provider,
        aggregateMapping: {
          ...testAggregateMapping,
          Label: defineEntity({ type: 'Label', aggregates: [to('Post', foreignKey('postId'))] }),
        },
        performance: { awaitWrite: true },
        fetchBefore: { update: true, delete: fetchBeforeDelete },
        errorHandling: { observer },
      });
      return { basePrisma, provider, prisma };
    };

    it('records a createMany row that leaves an optional foreign key out with null, and reports nothing', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, provider, prisma } = createClientWith(true, observer);
      try {
        await provider.runAsync(testActor, () => prisma.label.createMany({ data: [{ id: 'l-unlinked', name: 'l' }] }));
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      expect(observer).not.toHaveBeenCalled();
      expect(await aggregatesOf(context.basePrisma, 'Label')).toEqual(['l-unlinked:Label:l-unlinked']);
      const [record] = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Label' } });
      expect(record?.after).toMatchObject({ id: 'l-unlinked', postId: null });
    });

    it('records a row a nested delete removes without reading it under the parent it was deleted from, and reports nothing', async () => {
      const author = await createAuthor();
      const post = await context.basePrisma.post.create({ data: { id: 'p-deleted', title: 'P', authorId: author.id } });
      await context.basePrisma.comment.create({
        data: { id: 'c-deleted', content: 'C', postId: post.id, authorId: author.id },
      });
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, provider, prisma } = createClientWith(false, observer);
      try {
        await provider.runAsync(testActor, () =>
          prisma.post.update({ where: { id: post.id }, data: { comments: { delete: { id: 'c-deleted' } } } }),
        );
        await provider.runAsync(testActor, () =>
          prisma.user.update({ where: { id: author.id }, data: { posts: { delete: { id: post.id } } } }),
        );
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      expect(observer).not.toHaveBeenCalled();
      // The comment's author is not a column of the relation it was deleted through, so its
      // User root is unknown without the read and is left out
      expect(await aggregatesOf(context.basePrisma, 'Comment')).toEqual([
        'c-deleted:Comment:c-deleted',
        'c-deleted:Post:p-deleted',
      ]);
      expect(await aggregatesOf(context.basePrisma, 'Post')).toEqual([
        'p-deleted:Post:p-deleted',
        `p-deleted:User:${author.id}`,
      ]);
    });

    it('records a row a nested delete removes without reading it under the nested parent it was deleted from', async () => {
      const author = await createAuthor();
      const post = await context.basePrisma.post.create({ data: { id: 'p-parent', title: 'P', authorId: author.id } });
      await context.basePrisma.comment.create({
        data: { id: 'c-grandchild', content: 'C', postId: post.id, authorId: author.id },
      });
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, provider, prisma } = createClientWith(false, observer);
      try {
        await provider.runAsync(testActor, () =>
          prisma.user.update({
            where: { id: author.id },
            data: {
              posts: { update: { where: { id: post.id }, data: { comments: { delete: { id: 'c-grandchild' } } } } },
            },
          }),
        );
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }

      expect(observer).not.toHaveBeenCalled();
      // The post it was deleted through is known by the primary key its read encodes
      expect(await aggregatesOf(context.basePrisma, 'Comment')).toEqual([
        'c-grandchild:Comment:c-grandchild',
        'c-grandchild:Post:p-parent',
      ]);
    });
  });
});
