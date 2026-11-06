/**
 * Integration Test: an atomic operation commits only with every record it should produce
 *
 * A failure that drops a record of an atomic operation (`row-identification`, `id-resolver-call`,
 * a `pre-fetch` failure that leaves an upsert or connectOrCreate row, or a row a detaching nested
 * link write unlinked without naming it, unrecorded; only rows of an audited model count) fails the operation with
 * `AuditIncompleteError`, whose `failures` are the failures reported for it, and rolls back the
 * transaction the operation runs in, even when the caller catches the error inside its
 * `$transaction` callback. A record without its before state is not dropped and does not fail it.
 * Under `awaited` the same failures are only reported and the operation commits.
 */

import type { AuditContext, AuditObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { EntityMap, WriteMode } from '@kuruwic/prisma-audit';
import { AuditIncompleteError, AuditRollbackError, createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failureSummariesOf } from './helpers/audit-failures.js';
import { createPostReadFault } from './helpers/post-read-fault.js';
import { cleanDatabase, createBasePrisma, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'atomic-incomplete-actor' },
};

const FAILURE_MESSAGE = 'simulated before-state fetch failure';

describe('an atomic operation whose records a failure dropped', () => {
  const disconnects: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  describe('row-identification: an updateMany whose data changes the key of its rows by an operator', () => {
    const setup = async (mode: WriteMode) => {
      const observer = vi.fn<AuditObserver>();
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: { AutoIncItem: defineEntity({ type: 'AutoIncItem' }) },
        write: { mode },
        observer,
      });
      disconnects.push(async () => {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      });
      await cleanDatabase(basePrisma);
      await basePrisma.autoIncItem.createMany({
        data: [
          { id: 1, label: 'one' },
          { id: 2, label: 'two' },
        ],
      });
      const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
      const itemIds = async () =>
        (await basePrisma.autoIncItem.findMany({ orderBy: { id: 'asc' } })).map(({ id }) => id);
      return { basePrisma, prisma, observer, run, itemIds };
    };
    const incrementKeys = { data: { id: { increment: 100 } } } as const;

    it('fails with AuditIncompleteError carrying the failure and rolls the write back outside any transaction', async () => {
      const { basePrisma, prisma, observer, run, itemIds } = await setup('atomic');

      const updated = run(() => prisma.autoIncItem.updateMany(incrementKeys));

      await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(updated).rejects.toMatchObject({
        modelName: 'AutoIncItem',
        operation: 'updateMany',
        failures: [
          expect.objectContaining({
            phase: 'row-identification',
            modelName: 'AutoIncItem',
            unidentified: 2,
          }),
        ],
        unrecordedWrites: [],
      });
      expect(observer.mock.calls).toEqual([
        [
          expect.objectContaining({
            model: 'AutoIncItem',
            operation: 'updateMany',
            status: 'not-committed',
            failures: [expect.objectContaining({ phase: 'row-identification', unidentified: 2 })],
          }),
        ],
      ]);
      expect(await itemIds()).toEqual([1, 2]);
      expect(await basePrisma.auditLog.count()).toBe(0);
    });

    it('rolls the caller transaction back when the callback catches the error and resolves', async () => {
      const { basePrisma, prisma, run, itemIds } = await setup('atomic');

      const transaction = run(() =>
        prisma.$transaction(async (tx) => {
          await tx.autoIncItem.create({ data: { id: 3, label: 'three' } });
          await tx.autoIncItem.updateMany(incrementKeys).catch(() => undefined);
          return 'resolved';
        }),
      );

      await expect(transaction).rejects.toBeInstanceOf(AuditRollbackError);
      await expect(transaction).rejects.toMatchObject({ cause: expect.any(AuditIncompleteError) });
      expect(await itemIds()).toEqual([1, 2]);
      expect(await basePrisma.auditLog.count()).toBe(0);
    });

    it('commits under awaited, only reporting the rows it cannot identify', async () => {
      const { basePrisma, prisma, observer, run, itemIds } = await setup('awaited');

      await expect(run(() => prisma.autoIncItem.updateMany(incrementKeys))).resolves.toEqual({ count: 2 });

      expect(observer.mock.calls).toEqual([
        [
          expect.objectContaining({
            model: 'AutoIncItem',
            operation: 'updateMany',
            status: 'incomplete',
            failures: [
              expect.objectContaining({
                phase: 'row-identification',
                modelName: 'AutoIncItem',
                operation: 'updateMany',
                unidentified: 2,
              }),
            ],
          }),
        ],
      ]);
      expect(await itemIds()).toEqual([101, 102]);
      expect(await basePrisma.auditLog.count()).toBe(0);
    });
  });

  describe('the before-state read of a top-level write that fails', () => {
    const setup = async () => {
      const rawBasePrisma = createBasePrisma();
      const { findUnique, armFindUniqueFailure } = createPostReadFault(FAILURE_MESSAGE);
      const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: { post: { findUnique } } });
      const observer = vi.fn<AuditObserver>();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        observer,
      });
      disconnects.push(async () => {
        await prisma.$disconnect();
        await rawBasePrisma.$disconnect();
      });
      await cleanDatabase(rawBasePrisma);
      const author = await rawBasePrisma.user.create({ data: { email: 'atomic-author@example.com', name: 'Author' } });
      const post = await rawBasePrisma.post.create({ data: { title: 'Original', authorId: author.id } });
      const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
      return { rawBasePrisma, prisma, observer, run, post, armFindUniqueFailure };
    };

    it('fails an upsert, whose action the read decides, with AuditIncompleteError and rolls it back', async () => {
      const { rawBasePrisma, prisma, run, post, armFindUniqueFailure } = await setup();

      armFindUniqueFailure();
      const upserted = run(() =>
        prisma.post.upsert({
          where: { id: post.id },
          create: { title: 'Never used', authorId: post.authorId },
          update: { title: 'Updated' },
        }),
      );

      await expect(upserted).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(upserted).rejects.toMatchObject({
        failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'Post', operation: 'upsert' })],
      });
      expect((await rawBasePrisma.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Original');
      expect(await rawBasePrisma.auditLog.count({ where: { entityType: 'Post' } })).toBe(0);
    });

    it('commits an update, recording it without its before state, which is not a dropped record', async () => {
      const { rawBasePrisma, prisma, observer, run, post, armFindUniqueFailure } = await setup();

      armFindUniqueFailure();
      await expect(
        run(() => prisma.post.update({ where: { id: post.id }, data: { title: 'Updated' } })),
      ).resolves.toMatchObject({ title: 'Updated' });

      expect(observer.mock.calls).toEqual([
        [
          expect.objectContaining({
            model: 'Post',
            operation: 'update',
            status: 'complete',
            failures: [
              expect.objectContaining({
                phase: 'pre-fetch',
                modelName: 'Post',
                operation: 'update',
                error: expect.objectContaining({ message: FAILURE_MESSAGE }),
              }),
            ],
          }),
        ],
      ]);
      expect(
        await rawBasePrisma.auditLog.findMany({
          where: { entityType: 'Post', action: 'update' },
          select: { aggregateType: true, before: true, changes: true, beforeUnavailable: true },
          orderBy: { aggregateType: 'asc' },
        }),
      ).toEqual([
        { aggregateType: 'Post', before: null, changes: null, beforeUnavailable: true },
        { aggregateType: 'User', before: null, changes: null, beforeUnavailable: true },
      ]);
    });
  });

  describe('a nested write whose read failed', () => {
    type FaultTarget = {
      readonly model: 'User' | 'Post' | 'Comment' | 'Label' | 'Badge';
      readonly operation: 'findUnique' | 'findFirst' | 'findMany';
    };

    /** An audited client whose next `fault.operation` call on `fault.model` after `arm()` throws once */
    const setup = async (fault: FaultTarget, mode: WriteMode = 'atomic', entities: EntityMap = testEntities) => {
      const rawBasePrisma = createBasePrisma();
      let armed = false;
      const basePrisma = rawBasePrisma.$extends({
        name: 'fault-injection',
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              if (armed && model === fault.model && operation === fault.operation) {
                armed = false;
                throw new Error(`simulated ${fault.model}.${fault.operation} failure`);
              }
              return query(args);
            },
          },
        },
      });
      const observer = vi.fn<AuditObserver>();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities,
        diffExcludeFields: ['createdAt', 'updatedAt'],
        fetchBefore: { update: true, delete: true },
        write: { mode },
        observer,
      });
      disconnects.push(async () => {
        await prisma.$disconnect();
        await rawBasePrisma.$disconnect();
      });
      await cleanDatabase(rawBasePrisma);

      const user = await rawBasePrisma.user.create({
        data: { id: 'u1', email: 'atomic-nested@example.com', name: 'Owner' },
      });
      const post = await rawBasePrisma.post.create({ data: { id: 'p1', title: 'Post', authorId: user.id } });
      const c1 = await rawBasePrisma.comment.create({
        data: { id: 'c1', content: 'one', postId: post.id, authorId: user.id },
      });
      const c2 = await rawBasePrisma.comment.create({
        data: { id: 'c2', content: 'two', postId: post.id, authorId: user.id },
      });
      await rawBasePrisma.label.create({ data: { id: 'l1', name: 'l1', postId: post.id } });
      await rawBasePrisma.label.create({ data: { id: 'l2', name: 'l2' } });
      await rawBasePrisma.badge.create({ data: { id: 'b1', name: 'b1', userId: user.id } });

      const arm = () => {
        armed = true;
      };
      const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
      const phases = () => failureSummariesOf(observer);
      const recordsOf = (entityType: string) =>
        rawBasePrisma.auditLog.findMany({
          where: { entityType, aggregateType: entityType },
          select: { entityId: true, action: true, beforeUnavailable: true },
          orderBy: { entityId: 'asc' },
        });
      return { rawBasePrisma, prisma, post, c1, c2, arm, run, phases, recordsOf };
    };

    it('fails a nested upsert below a row that cannot be identified, which is left without a record, and rolls it back', async () => {
      const { rawBasePrisma, prisma, post, c1, c2, arm, run } = await setup({ model: 'User', operation: 'findFirst' });

      arm();
      const updated = run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            author: {
              update: {
                name: 'Owner updated',
                comments: {
                  update: { where: { id: c1.id }, data: { content: 'one updated' } },
                  upsert: {
                    where: { id: c2.id },
                    create: { content: 'created', post: { connect: { id: post.id } } },
                    update: { content: 'two updated' },
                  },
                },
              },
            },
          },
        }),
      );

      await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(updated).rejects.toMatchObject({
        modelName: 'Post',
        operation: 'update',
        failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'User', operation: 'update' })],
      });
      expect((await rawBasePrisma.comment.findUniqueOrThrow({ where: { id: c2.id } })).content).toBe('two');
      expect(await rawBasePrisma.auditLog.count()).toBe(0);
    });

    it.each([
      [
        'a to-many upsert that updates a row it could not read',
        {
          upsert: {
            where: { id: 'c1' },
            create: { content: 'created', authorId: 'u1' },
            update: { content: 'one updated' },
          },
        },
        'upsert',
      ],
      [
        'a connectOrCreate that connects a row it could not read',
        { connectOrCreate: { where: { id: 'c1' }, create: { content: 'created', authorId: 'u1' } } },
        'connectOrCreate',
      ],
    ] as const)('fails %s and rolls it back', async (_, comments, keyword) => {
      const { rawBasePrisma, prisma, post, c1, arm, run } = await setup({ model: 'Comment', operation: 'findUnique' });

      arm();
      const updated = run(() => prisma.post.update({ where: { id: post.id }, data: { title: 'Renamed', comments } }));

      await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(updated).rejects.toMatchObject({
        failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'Comment', operation: keyword })],
      });
      expect(await rawBasePrisma.comment.findUniqueOrThrow({ where: { id: c1.id } })).toMatchObject({ content: 'one' });
      expect((await rawBasePrisma.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Post');
      expect(await rawBasePrisma.auditLog.count()).toBe(0);
    });

    it.each([
      [
        'a to-many upsert',
        {
          upsert: {
            where: { id: 'missing' },
            create: { id: 'c-new', content: 'created', authorId: 'u1' },
            update: { content: 'updated' },
          },
        },
        'upsert',
      ],
      [
        'a connectOrCreate',
        { connectOrCreate: { where: { id: 'missing' }, create: { id: 'c-new', content: 'created', authorId: 'u1' } } },
        'connectOrCreate',
      ],
    ] as const)(
      'fails %s whose target it could not read that creates a row under another key than its WHERE names, and rolls it back',
      async (_, comments, keyword) => {
        const { rawBasePrisma, prisma, post, arm, run } = await setup({ model: 'Comment', operation: 'findUnique' });

        arm();
        const updated = run(() => prisma.post.update({ where: { id: post.id }, data: { title: 'Renamed', comments } }));

        await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
        await expect(updated).rejects.toMatchObject({
          failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'Comment', operation: keyword })],
          unrecordedWrites: [{ modelName: 'Comment', operation: keyword, path: 'comments' }],
        });
        expect(await rawBasePrisma.comment.findUnique({ where: { id: 'c-new' } })).toBeNull();
        expect((await rawBasePrisma.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Post');
        expect(await rawBasePrisma.auditLog.count()).toBe(0);
      },
    );

    it('commits an upsert of a model that is not audited whose branch it could not read when only another element of it writes an audited model', async () => {
      const { Post: _unaudited, ...entities } = testEntities;
      const { rawBasePrisma, prisma, post, arm, run, phases, recordsOf } = await setup(
        { model: 'Post', operation: 'findUnique' },
        'atomic',
        entities,
      );
      await rawBasePrisma.post.create({ data: { id: 'p2', title: 'Second', authorId: 'u1' } });

      arm();
      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: {
            posts: {
              upsert: [
                {
                  where: { id: post.id },
                  create: { title: 'Created' },
                  update: { title: 'Renamed' },
                },
                {
                  where: { id: 'p2' },
                  create: { title: 'Created' },
                  update: { comments: { create: { id: 'c3', content: 'three', authorId: 'u1' } } },
                },
              ],
            },
          },
        }),
      );

      expect(phases()).toEqual([['pre-fetch', 'Post', 'upsert']]);
      expect((await rawBasePrisma.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Renamed');
      expect(
        (await recordsOf('Comment')).filter(({ entityId }) => entityId === 'c3').map(({ action }) => action),
      ).toEqual(['create']);
    });

    describe('a set whose read of the rows it may re-link fails, while the parent row holds a row the set does not name', () => {
      const setLabels = { labels: { set: [{ id: 'l2' }] } };

      it('fails with AuditIncompleteError and rolls it back, the unnamed row being left without a record', async () => {
        const { rawBasePrisma, prisma, post, arm, run } = await setup({ model: 'Label', operation: 'findMany' });

        arm();
        const updated = run(() => prisma.post.update({ where: { id: post.id }, data: setLabels }));

        await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
        await expect(updated).rejects.toMatchObject({
          failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'Label', operation: 'set' })],
        });
        const labels = await rawBasePrisma.label.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, postId: true },
        });
        expect(labels).toEqual([
          { id: 'l1', postId: post.id },
          { id: 'l2', postId: null },
        ]);
        expect(await rawBasePrisma.auditLog.count()).toBe(0);
      });

      it('commits under awaited, recording the named row without its before state and reporting the read', async () => {
        const { rawBasePrisma, prisma, post, arm, run, phases, recordsOf } = await setup(
          { model: 'Label', operation: 'findMany' },
          'awaited',
        );

        arm();
        await run(() => prisma.post.update({ where: { id: post.id }, data: setLabels }));

        const labels = await rawBasePrisma.label.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, postId: true },
        });
        expect(labels).toEqual([
          { id: 'l1', postId: null },
          { id: 'l2', postId: post.id },
        ]);
        expect(phases()).toEqual([['pre-fetch', 'Label', 'set']]);
        expect(await recordsOf('Label')).toEqual([{ entityId: 'l2', action: 'update', beforeUnavailable: true }]);
      });
    });

    it('commits a disconnect whose read failed, every row it unlinks being named, recording the row without its before state', async () => {
      const { prisma, post, arm, run, phases, recordsOf } = await setup({ model: 'Label', operation: 'findMany' });

      arm();
      await run(() => prisma.post.update({ where: { id: post.id }, data: { labels: { disconnect: { id: 'l1' } } } }));

      expect(phases()).toEqual([['pre-fetch', 'Label', 'disconnect']]);
      expect(await recordsOf('Label')).toEqual([{ entityId: 'l1', action: 'update', beforeUnavailable: true }]);
    });

    it('fails a to-one disconnect below a row that cannot be identified, the row it unlinks being left without a record, and rolls it back', async () => {
      const { rawBasePrisma, prisma, post, arm, run } = await setup({ model: 'User', operation: 'findFirst' });

      arm();
      const updated = run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: { author: { update: { name: 'Owner updated', badge: { disconnect: true } } } },
        }),
      );

      await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(updated).rejects.toMatchObject({
        failures: [expect.objectContaining({ phase: 'pre-fetch', modelName: 'User', operation: 'update' })],
      });
      expect(await rawBasePrisma.badge.findUniqueOrThrow({ where: { id: 'b1' } })).toMatchObject({ userId: 'u1' });
      expect(await rawBasePrisma.auditLog.count()).toBe(0);
    });

    it('commits a to-one create below a row the operation creates, which holds no row to unlink', async () => {
      const { rawBasePrisma, prisma, run, arm, phases, recordsOf } = await setup({
        model: 'User',
        operation: 'findFirst',
      });

      arm();
      await run(() =>
        prisma.post.create({
          data: {
            id: 'p2',
            title: 'New',
            author: {
              create: { id: 'u2', email: 'atomic-new@example.com', badge: { create: { id: 'b2', name: 'b2' } } },
            },
          },
        }),
      );

      expect(phases()).toEqual([]);
      expect(await rawBasePrisma.badge.findUniqueOrThrow({ where: { id: 'b2' } })).toMatchObject({ userId: 'u2' });
      expect((await recordsOf('Badge')).map(({ entityId, action }) => [entityId, action])).toEqual([['b2', 'create']]);
    });
    it.each<[string, FaultTarget, 'Label' | 'Comment', Prisma.PostUpdateInput, string]>([
      [
        'a set whose read of the rows it may re-link fails',
        { model: 'Label', operation: 'findMany' },
        'Label',
        { labels: { set: [{ id: 'l2' }] } },
        'set',
      ],
      [
        'a to-many upsert that updates a row it could not read',
        { model: 'Comment', operation: 'findUnique' },
        'Comment',
        {
          comments: {
            upsert: {
              where: { id: 'c1' },
              create: { content: 'created', authorId: 'u1' },
              update: { content: 'one updated' },
            },
          },
        },
        'upsert',
      ],
    ])(
      'commits %s on a model that is not audited, which leaves no audited row without a record',
      async (_, fault, unaudited, data, keyword) => {
        const { [unaudited]: _unaudited, ...entities } = testEntities;
        const { rawBasePrisma, prisma, post, arm, run, phases, recordsOf } = await setup(fault, 'atomic', entities);

        arm();
        await run(() => prisma.post.update({ where: { id: post.id }, data: { title: 'Renamed', ...data } }));

        expect(phases()).toEqual([['pre-fetch', unaudited, keyword]]);
        expect((await rawBasePrisma.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Renamed');
        expect((await recordsOf('Post')).map(({ entityId, action }) => [entityId, action])).toEqual([
          [post.id, 'update'],
        ]);
      },
    );

    it('fails an upsert of a model that is not audited whose branch it could not read writes an audited model, and rolls it back', async () => {
      const { Comment: _unaudited, ...entities } = testEntities;
      const { rawBasePrisma, prisma, post, arm, run } = await setup(
        { model: 'Comment', operation: 'findUnique' },
        'atomic',
        entities,
      );

      arm();
      const updated = run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            title: 'Renamed',
            comments: {
              upsert: {
                where: { id: 'c1' },
                create: {
                  content: 'created',
                  authorId: 'u1',
                  commentAttachments: {
                    create: {
                      attachment: { create: { fileUrl: 'https://example.com/a', fileName: 'a', ownerId: 'u1' } },
                    },
                  },
                },
                update: { content: 'one updated' },
              },
            },
          },
        }),
      );

      await expect(updated).rejects.toBeInstanceOf(AuditIncompleteError);
      await expect(updated).rejects.toMatchObject({
        unrecordedWrites: [{ modelName: 'Comment', operation: 'upsert', path: 'comments' }],
      });
      expect((await rawBasePrisma.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Post');
      expect(await rawBasePrisma.auditLog.count()).toBe(0);
    });

    it('commits a to-one create below the row a top-level upsert creates, which holds no row to unlink', async () => {
      const { rawBasePrisma, prisma, arm, run, phases, recordsOf } = await setup({
        model: 'Badge',
        operation: 'findMany',
      });

      arm();
      await run(() =>
        prisma.user.upsert({
          where: { id: 'u2' },
          create: { id: 'u2', email: 'atomic-upsert@example.com', badge: { create: { id: 'b2', name: 'b2' } } },
          update: { name: 'Updated' },
        }),
      );

      expect(phases()).toEqual([['pre-fetch', 'Badge', 'create']]);
      expect(await rawBasePrisma.badge.findUniqueOrThrow({ where: { id: 'b2' } })).toMatchObject({ userId: 'u2' });
      expect((await recordsOf('Badge')).map(({ entityId, action }) => [entityId, action])).toEqual([['b2', 'create']]);
    });
  });

  it('id-resolver-call: fails a create whose entity idResolver throws with AuditIncompleteError and rolls it back', async () => {
    const resolverError = new Error('entity id resolver is broken');
    const basePrisma = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: {
        ...testEntities,
        Tag: defineEntity({
          type: 'Tag',
          idResolver: async () => {
            throw resolverError;
          },
        }),
      },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const created = provider.runAsync(testActor, () => prisma.tag.create({ data: { name: 'unresolvable' } }));

    await expect(created).rejects.toBeInstanceOf(AuditIncompleteError);
    await expect(created).rejects.toMatchObject({
      failures: [expect.objectContaining({ phase: 'id-resolver-call', modelName: 'Tag', error: resolverError })],
    });
    expect(await basePrisma.tag.count({ where: { name: 'unresolvable' } })).toBe(0);
  });
});
