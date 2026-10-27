/**
 * Integration Test: a commit that lands between the audit's read and the write, on PostgreSQL
 *
 * The audit reads the before state of a write, the rows a batch operation touches and the children
 * a nested create sits beside with separate statements ahead of the write. These tests hold the
 * audited operation right after that read with a read barrier applied to the base client before the
 * audit extension (`helpers/read-barrier.ts`), commit a write on another client without the audit
 * while it is held, then let it continue, and pin down what the audit records under each isolation
 * level and each concurrency control an application can add. The other writer's own writes are not
 * audited, so every audit log a test reads is the held operation's.
 */

import type { AuditContext, AuditErrorContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BarrierTarget, createReadBarrier, interleave, type Settled } from '../helpers/read-barrier.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from '../helpers/setup.js';

const actor: AuditContext = { actor: { category: 'model', type: 'User', id: 'concurrent-writer' } };

/** Longer than the barrier holds a read, so a held transaction never times out on its own */
const TRANSACTION_TIMEOUT_MS = 30_000;

const POST_ID = 'contended-post';

const postFindUnique: BarrierTarget = { model: 'Post', read: 'findUnique' };
const postFindMany: BarrierTarget = { model: 'Post', read: 'findMany' };

const errorCodesOf = (settled: Settled<unknown>) => {
  if (settled.status !== 'rejected' || !(settled.reason instanceof Prisma.PrismaClientKnownRequestError)) {
    return settled;
  }
  const driverAdapterError: unknown = settled.reason.meta?.driverAdapterError;
  const cause: unknown =
    typeof driverAdapterError === 'object' && driverAdapterError !== null
      ? Reflect.get(driverAdapterError, 'cause')
      : undefined;
  const sqlState: unknown =
    typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'originalCode') : undefined;
  return { code: settled.reason.code, sqlState };
};

describe('concurrent writes on PostgreSQL: a commit between the audit read and the write', () => {
  const queries: string[] = [];
  const observer = vi.fn<(context: AuditErrorContext) => void>();
  const barrier = createReadBarrier();
  const provider = createAsyncLocalStorageProvider();

  const rawBase = createBasePrisma({ log: [{ emit: 'event', level: 'query' }] });
  rawBase.$on('query', (event) => {
    queries.push(event.query);
  });
  const base = rawBase.$extends({ name: 'read-barrier', query: barrier.query });
  const auditOptions = { ...testAuditOptions(provider, { Prisma, schema: auditSchema }), errorObserver: observer };
  const prisma = createAuditClient(base, auditOptions);
  const implicitPrisma = createAuditClient(base, {
    ...auditOptions,
    write: { awaited: true, implicitTransaction: true },
  });
  type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
  /** The other writer: a client without the audit */
  const other = createBasePrisma();

  let authorId = '';

  const asActor = <T>(run: () => Promise<T>) => provider.runAsync(actor, run);

  const inTransaction = <T>(isolationLevel: Prisma.TransactionIsolationLevel, run: (tx: Transaction) => Promise<T>) =>
    asActor(() => prisma.$transaction(run, { isolationLevel, timeout: TRANSACTION_TIMEOUT_MS }));

  const readCommitted = <T>(run: (tx: Transaction) => Promise<T>) =>
    inTransaction(Prisma.TransactionIsolationLevel.ReadCommitted, run);

  /** The audit log of a Post row under its own aggregate (each Post write is also logged under its author) */
  const postRecords = (entityId: string) =>
    other.auditLog.findMany({
      where: { entityType: 'Post', entityId, aggregateType: 'Post' },
      orderBy: { createdAt: 'asc' },
    });

  const postOf = (id: string) => other.post.findUnique({ where: { id } });

  const seedPost = (id: string, data: { title?: string; published?: boolean } = {}) =>
    other.post.create({ data: { id, title: '100', authorId, ...data } });

  const upsertedPost = { where: { id: POST_ID }, update: { title: '120' } };
  /** An upsert whose `create` gives the unique value its `where` names: Prisma runs it as INSERT ... ON CONFLICT */
  const nativeUpsert = () => ({ ...upsertedPost, create: { id: POST_ID, title: 'created', authorId } });
  /** An upsert whose `create` leaves out the unique value its `where` names: Prisma emulates it */
  const emulatedUpsert = () => ({ ...upsertedPost, create: { title: 'created', authorId } });

  /** Native upsert or the emulation's first statement in the query log, which holds succeeded statements only */
  const ranOnConflict = () => queries.some((query) => /\bON CONFLICT\b/.test(query));
  const ranEmulatedExistenceCheck = () => queries.some((query) => /^SELECT "public"\."posts"\."id" FROM/.test(query));

  afterAll(async () => {
    await prisma.$disconnect();
    await implicitPrisma.$disconnect();
    await rawBase.$disconnect();
    await other.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(other);
    authorId = (await other.user.create({ data: { email: 'author@example.com', name: 'Author' } })).id;
    observer.mockClear();
    queries.length = 0;
  });

  describe('documented limitation: a write outside any transaction', () => {
    it('records the before state read ahead of a commit that lands between the read and the update, outside any transaction', async () => {
      await seedPost(POST_ID);

      const outcome = await interleave(barrier, postFindUnique, {
        operation: () => asActor(() => prisma.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
        interleaved: () => other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect((await postOf(POST_ID))?.title).toBe('120');
      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100' }),
          after: expect.objectContaining({ title: '120' }),
        }),
      ]);
    });
  });

  describe('documented limitation: READ COMMITTED', () => {
    it('records the before state read ahead of a commit that lands between the read and the update in a READ COMMITTED transaction', async () => {
      await seedPost(POST_ID);

      const outcome = await interleave(barrier, postFindUnique, {
        operation: () => readCommitted((tx) => tx.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
        interleaved: () => other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect((await postOf(POST_ID))?.title).toBe('120');
      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100' }),
          after: expect.objectContaining({ title: '120' }),
        }),
      ]);
    });

    it('records the before state read ahead of a commit that lands between the read and the update in the transaction write.implicitTransaction opens', async () => {
      await seedPost(POST_ID);

      const outcome = await interleave(barrier, postFindUnique, {
        operation: () => asActor(() => implicitPrisma.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
        interleaved: () => other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect((await postOf(POST_ID))?.title).toBe('120');
      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100' }),
          after: expect.objectContaining({ title: '120' }),
        }),
      ]);
    });

    it('records a native upsert (INSERT ... ON CONFLICT DO UPDATE) as a create with no before state when another transaction inserts its row between the read and the upsert, which updates that row', async () => {
      const outcome = await interleave(barrier, postFindUnique, {
        operation: () => readCommitted((tx) => tx.post.upsert(nativeUpsert())),
        interleaved: () => seedPost(POST_ID, { title: '110' }),
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect(ranOnConflict()).toBe(true);
      expect(ranEmulatedExistenceCheck()).toBe(false);
      expect((await postOf(POST_ID))?.title).toBe('120');
      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({ action: 'create', before: null, after: expect.objectContaining({ title: '120' }) }),
      ]);
    });

    it('records an emulated upsert as a create with no before state when another transaction inserts its row between the read and the upsert, which takes the update branch', async () => {
      const outcome = await interleave(barrier, postFindUnique, {
        operation: () => readCommitted((tx) => tx.post.upsert(emulatedUpsert())),
        interleaved: () => seedPost(POST_ID, { title: '110' }),
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect(ranOnConflict()).toBe(false);
      expect(ranEmulatedExistenceCheck()).toBe(true);
      expect(queries.some((query) => /^UPDATE "public"\."posts"/.test(query))).toBe(true);
      expect(queries.some((query) => /^INSERT INTO "public"\."posts"/.test(query))).toBe(false);
      expect((await postOf(POST_ID))?.title).toBe('120');
      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({ action: 'create', before: null, after: expect.objectContaining({ title: '120' }) }),
      ]);
    });
  });

  describe('REPEATABLE READ and SERIALIZABLE', () => {
    const levels = [Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable];

    it.each(levels)(
      'rejects an update under %s with a write conflict when another transaction commits a change to its row between the read and the update, recording nothing',
      async (isolationLevel) => {
        await seedPost(POST_ID);

        const outcome = await interleave(barrier, postFindUnique, {
          operation: () =>
            inTransaction(isolationLevel, (tx) => tx.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
          interleaved: () => other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
        });

        expect(errorCodesOf(outcome.operation)).toEqual({ code: 'P2034', sqlState: '40001' });
        expect((await postOf(POST_ID))?.title).toBe('110');
        expect(await postRecords(POST_ID)).toEqual([]);
      },
    );

    it.each(levels)(
      'rejects a native upsert under %s with a write conflict when another transaction inserts its row between the read and the upsert, recording nothing (ON CONFLICT DO UPDATE against a row the snapshot does not see, which the PostgreSQL documentation does not state)',
      async (isolationLevel) => {
        const outcome = await interleave(barrier, postFindUnique, {
          operation: () => inTransaction(isolationLevel, (tx) => tx.post.upsert(nativeUpsert())),
          interleaved: () => seedPost(POST_ID, { title: '110' }),
        });

        expect(errorCodesOf(outcome.operation)).toEqual({ code: 'P2034', sqlState: '40001' });
        // The failed INSERT ... ON CONFLICT is not logged; the emulation's existence check, which succeeds, would be
        expect(ranEmulatedExistenceCheck()).toBe(false);
        expect((await postOf(POST_ID))?.title).toBe('110');
        expect(await postRecords(POST_ID)).toEqual([]);
      },
    );
  });

  describe('concurrency control the application adds under READ COMMITTED', () => {
    const versionedUpdate = (tx: Transaction) =>
      tx.post.findUniqueOrThrow({ where: { id: POST_ID } }).then((read) =>
        tx.post.update({
          where: { id: POST_ID, version: read.version },
          data: { title: '120', version: { increment: 1 } },
        }),
      );

    it('rejects an update guarded by a version column every writer advances when another transaction advances it between the read and the update, recording nothing', async () => {
      await seedPost(POST_ID);
      // The audit's read names the version in its where; the caller's own read of the version does not
      const auditRead: BarrierTarget = {
        ...postFindUnique,
        match: (args) => {
          const where: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'where') : undefined;
          return typeof where === 'object' && where !== null && 'version' in where;
        },
      };

      const outcome = await interleave(barrier, auditRead, {
        operation: () => readCommitted(versionedUpdate),
        interleaved: () =>
          other.post.update({ where: { id: POST_ID }, data: { content: 'by the other', version: { increment: 1 } } }),
      });

      expect(errorCodesOf(outcome.operation)).toEqual({ code: 'P2025', sqlState: undefined });
      expect(await postOf(POST_ID)).toMatchObject({ title: '100', content: 'by the other', version: 1 });
      expect(await postRecords(POST_ID)).toEqual([]);
    });

    it('records the exact before state of an update guarded by a version column when no other transaction writes the row', async () => {
      await seedPost(POST_ID);

      await readCommitted(versionedUpdate);

      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100', version: 0 }),
          after: expect.objectContaining({ title: '120', version: 1 }),
        }),
      ]);
    });

    it('records the before state of an update whose row the transaction locked with SELECT ... FOR UPDATE, and the other writer applies its change after the transaction commits', async () => {
      await seedPost(POST_ID);

      const outcome = await interleave(barrier, postFindUnique, {
        operation: () =>
          readCommitted(async (tx) => {
            await tx.$queryRaw`SELECT id FROM posts WHERE id = ${POST_ID} FOR UPDATE`;
            return tx.post.update({ where: { id: POST_ID }, data: { title: '120' } });
          }),
        // Blocks on the lock until the held transaction commits, whenever it reaches the database
        interleaved: () => other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
        awaitInterleaved: false,
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect(outcome.interleaved.status).toBe('fulfilled');
      expect((await postOf(POST_ID))?.title).toBe('110');
      expect(await postRecords(POST_ID)).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100' }),
          after: expect.objectContaining({ title: '120' }),
        }),
      ]);
    });
  });

  describe('documented limitation: batch and nested writes under READ COMMITTED', () => {
    const unpublished = { where: { published: false } };

    it('reports as row-identification, and does not record, a row another transaction inserts into the where of an updateMany between the read and the update, which updates it', async () => {
      await seedPost('read-1');
      await seedPost('read-2');

      const outcome = await interleave(barrier, postFindMany, {
        operation: () => readCommitted((tx) => tx.post.updateMany({ ...unpublished, data: { title: '120' } })),
        interleaved: () => seedPost('inserted'),
      });

      expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 3 } });
      expect((await postOf('inserted'))?.title).toBe('120');
      expect(await postRecords('inserted')).toEqual([]);
      for (const id of ['read-1', 'read-2']) {
        expect(await postRecords(id)).toEqual([expect.objectContaining({ action: 'update' })]);
      }
      expect(observer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Post',
          operation: 'updateMany',
          params: { unidentified: 1 },
        }),
      );
    });

    it('records a row another transaction moves out of the where of an updateMany between the read and the update as updated, misses the row it moves in, and reports nothing when the count does not change', async () => {
      await seedPost('moved-out');
      await seedPost('stays');

      const outcome = await interleave(barrier, postFindMany, {
        operation: () => readCommitted((tx) => tx.post.updateMany({ ...unpublished, data: { title: '120' } })),
        interleaved: () =>
          other.$transaction([
            other.post.update({ where: { id: 'moved-out' }, data: { published: true } }),
            other.post.create({ data: { id: 'moved-in', title: '100', authorId } }),
          ]),
      });

      expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 2 } });
      expect(await postOf('moved-out')).toMatchObject({ title: '100', published: true });
      expect((await postOf('moved-in'))?.title).toBe('120');
      expect(await postRecords('moved-out')).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100', published: false }),
          after: expect.objectContaining({ title: '100', published: true }),
        }),
      ]);
      expect(await postRecords('moved-in')).toEqual([]);
      expect(await postRecords('stays')).toEqual([expect.objectContaining({ action: 'update' })]);
      expect(observer).not.toHaveBeenCalled();
    });

    it('records the delete of a row another transaction deletes between the read and a deleteMany, and reports as row-identification that the deleteMany deleted fewer rows than it read', async () => {
      await seedPost('deleted-first');
      await seedPost('deleted-by-many');

      const outcome = await interleave(barrier, postFindMany, {
        operation: () => readCommitted((tx) => tx.post.deleteMany(unpublished)),
        interleaved: () => other.post.delete({ where: { id: 'deleted-first' } }),
      });

      expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 1 } });
      for (const id of ['deleted-first', 'deleted-by-many']) {
        expect(await postRecords(id)).toEqual([
          expect.objectContaining({ action: 'delete', before: expect.objectContaining({ id }) }),
        ]);
      }
      expect(observer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Post',
          operation: 'deleteMany',
          params: { unidentified: 1 },
        }),
      );
    });

    it("records a child another transaction inserts under the parent between the read of the parent's children and a nested to-many create as created by the nested create", async () => {
      await seedPost('existing-child');

      const outcome = await interleave(barrier, postFindMany, {
        operation: () =>
          readCommitted((tx) =>
            tx.user.update({
              where: { id: authorId },
              data: { posts: { create: { id: 'nested-child', title: 'created' } } },
            }),
          ),
        interleaved: () => seedPost('inserted-child', { title: 'by the other' }),
      });

      expect(outcome.operation.status).toBe('fulfilled');
      for (const id of ['nested-child', 'inserted-child']) {
        expect(await postRecords(id)).toEqual([expect.objectContaining({ action: 'create', before: null })]);
      }
      expect(await postRecords('existing-child')).toEqual([]);
    });
  });
});
