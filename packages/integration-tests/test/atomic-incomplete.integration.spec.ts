/**
 * Integration Test: an atomic operation commits only with every record it should produce
 *
 * A failure that drops a record of an atomic operation (`row-identification`, `id-resolver-call`,
 * an upsert skipped because its before-state read failed) fails the operation with
 * `AuditIncompleteError`, whose `failures` are those failures, and rolls back the transaction the
 * operation runs in, even when the caller catches the error inside its `$transaction` callback. A
 * record without its before state is not dropped and does not fail it. Under `awaited` the same
 * failures are only reported and the operation commits.
 */

import type { AuditContext, AuditErrorObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { WriteMode } from '@kuruwic/prisma-audit';
import { AuditIncompleteError, AuditRollbackError, createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      const observer = vi.fn<AuditErrorObserver>();
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: { AutoIncItem: defineEntity({ type: 'AutoIncItem' }) },
        write: { mode },
        errorObserver: observer,
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
            params: { unidentified: 2 },
          }),
        ],
      });
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'row-identification' }));
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

      expect(observer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ phase: 'row-identification', params: { unidentified: 2 } }),
      );
      expect(await itemIds()).toEqual([101, 102]);
      expect(await basePrisma.auditLog.count()).toBe(0);
    });
  });

  describe('the before-state read of a top-level write that fails', () => {
    const setup = async () => {
      const rawBasePrisma = createBasePrisma();
      const { findUnique, armFindUniqueFailure } = createPostReadFault(FAILURE_MESSAGE);
      const basePrisma = rawBasePrisma.$extends({ name: 'fault-injection', query: { post: { findUnique } } });
      const observer = vi.fn<AuditErrorObserver>();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
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

      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'pre-fetch', operation: 'update' }));
      expect(
        await rawBasePrisma.auditLog.findMany({
          where: { entityType: 'Post', aggregateType: 'Post' },
          select: { action: true, beforeUnavailable: true },
        }),
      ).toEqual([{ action: 'update', beforeUnavailable: true }]);
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
