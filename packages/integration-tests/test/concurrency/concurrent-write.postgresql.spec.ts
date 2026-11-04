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

import type { AuditContext, AuditObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { AuditIncompleteError, createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { failuresOf } from '../helpers/audit-failures.js';
import { carriedDatabaseCode, databaseCodeOf } from '../helpers/database-error-code.js';
import {
  type BarrierTarget,
  createReadBarrier,
  HELD_TRANSACTION_TIMEOUT_MS,
  interleave,
  type Settled,
} from '../helpers/read-barrier.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from '../helpers/setup.js';

const actor: AuditContext = { actor: { category: 'model', type: 'User', id: 'concurrent-writer' } };

const POST_ID = 'contended-post';

const postFindUnique: BarrierTarget = { model: 'Post', read: 'findUnique' };
const userFindUnique: BarrierTarget = { model: 'User', read: 'findUnique' };
const postFindMany: BarrierTarget = { model: 'Post', read: 'findMany' };
const autoIncChildFindMany: BarrierTarget = { model: 'AutoIncChild', read: 'findMany' };

const errorCodesOf = (settled: Settled<unknown>) => {
  if (settled.status !== 'rejected' || !(settled.reason instanceof Prisma.PrismaClientKnownRequestError)) {
    return settled;
  }
  return { code: settled.reason.code, sqlState: databaseCodeOf(settled.reason) };
};

describe('concurrent writes on PostgreSQL: a commit between the audit read and the write', () => {
  const queries: string[] = [];
  const observer = vi.fn<AuditObserver>();
  const barrier = createReadBarrier();
  const provider = createAsyncLocalStorageProvider();

  const rawBase = createBasePrisma({ log: [{ emit: 'event', level: 'query' }] });
  rawBase.$on('query', (event) => {
    queries.push(event.query);
  });
  const base = rawBase.$extends({ name: 'read-barrier', query: barrier.query });
  const auditOptions = { ...testAuditOptions(provider, { Prisma, schema: auditSchema }), observer };
  const prisma = createAuditClient(base, auditOptions);
  const atomicPrisma = createAuditClient(base, { ...auditOptions, write: { mode: 'atomic' } });
  type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
  /** The other writer: a client without the audit */
  const other = createBasePrisma();

  let authorId = '';

  const asActor = <T>(run: () => Promise<T>) => provider.runAsync(actor, run);

  const inTransaction = <T>(isolationLevel: Prisma.TransactionIsolationLevel, run: (tx: Transaction) => Promise<T>) =>
    asActor(() => prisma.$transaction(run, { isolationLevel, timeout: HELD_TRANSACTION_TIMEOUT_MS }));

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
    await atomicPrisma.$disconnect();
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

    it('records the before state read ahead of a commit that lands between the read and the update in the transaction the client opens for an atomic write', async () => {
      await seedPost(POST_ID);

      const outcome = await interleave(barrier, postFindUnique, {
        operation: () => asActor(() => atomicPrisma.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
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
    const unpublished = { where: { published: false } };

    it.each(levels)(
      'rejects an update under %s with a write conflict when another transaction commits a change to its row between the read and the update, recording nothing',
      async (isolationLevel) => {
        await seedPost(POST_ID);

        const outcome = await interleave(barrier, postFindUnique, {
          operation: () =>
            inTransaction(isolationLevel, (tx) => tx.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
          interleaved: () => other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
        });

        expect(errorCodesOf(outcome.operation)).toEqual({
          code: 'P2034',
          sqlState: carriedDatabaseCode(Prisma.prismaVersion.client, '40001'),
        });
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

        expect(errorCodesOf(outcome.operation)).toEqual({
          code: 'P2034',
          sqlState: carriedDatabaseCode(Prisma.prismaVersion.client, '40001'),
        });
        // The failed INSERT ... ON CONFLICT is not logged; the emulation's existence check, which succeeds, would be
        expect(ranEmulatedExistenceCheck()).toBe(false);
        expect((await postOf(POST_ID))?.title).toBe('110');
        expect(await postRecords(POST_ID)).toEqual([]);
      },
    );

    it.each(levels)(
      'rejects an updateMany under %s with a write conflict when another transaction moves a read row out of its where between the read and the update, recording nothing',
      async (isolationLevel) => {
        await seedPost('moved-out');
        await seedPost('stays');

        const outcome = await interleave(barrier, postFindMany, {
          operation: () =>
            inTransaction(isolationLevel, (tx) => tx.post.updateMany({ ...unpublished, data: { title: '120' } })),
          interleaved: () => other.post.update({ where: { id: 'moved-out' }, data: { published: true } }),
        });

        expect(errorCodesOf(outcome.operation)).toEqual({
          code: 'P2034',
          sqlState: carriedDatabaseCode(Prisma.prismaVersion.client, '40001'),
        });
        expect((await postOf('stays'))?.title).toBe('100');
        expect(await postOf('moved-out')).toMatchObject({ title: '100', published: true });
        expect(await postRecords('moved-out')).toEqual([]);
        expect(await postRecords('stays')).toEqual([]);
        expect(failuresOf(observer)).toEqual([]);
      },
    );

    it.each(levels)(
      'rejects a deleteMany under %s with a write conflict when another transaction deletes a read row between the read and the delete, recording nothing',
      async (isolationLevel) => {
        await seedPost('deleted-first');
        await seedPost('deleted-by-many');

        const outcome = await interleave(barrier, postFindMany, {
          operation: () => inTransaction(isolationLevel, (tx) => tx.post.deleteMany(unpublished)),
          interleaved: () => other.post.delete({ where: { id: 'deleted-first' } }),
        });

        expect(errorCodesOf(outcome.operation)).toEqual({
          code: 'P2034',
          sqlState: carriedDatabaseCode(Prisma.prismaVersion.client, '40001'),
        });
        expect(await postOf('deleted-by-many')).not.toBeNull();
        expect(await postRecords('deleted-first')).toEqual([]);
        expect(await postRecords('deleted-by-many')).toEqual([]);
        expect(failuresOf(observer)).toEqual([]);
      },
    );

    it.each(levels)(
      'records only the rows an updateMany under %s read when another transaction inserts a row into its where between the read and the update, which it leaves as it is, and reports nothing',
      async (isolationLevel) => {
        await seedPost('read-1');
        await seedPost('read-2');

        const outcome = await interleave(barrier, postFindMany, {
          operation: () =>
            inTransaction(isolationLevel, (tx) => tx.post.updateMany({ ...unpublished, data: { title: '120' } })),
          interleaved: () => seedPost('inserted'),
        });

        expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 2 } });
        expect((await postOf('inserted'))?.title).toBe('100');
        expect(await postRecords('inserted')).toEqual([]);
        for (const id of ['read-1', 'read-2']) {
          expect(await postRecords(id)).toEqual([
            expect.objectContaining({
              action: 'update',
              changes: expect.objectContaining({ title: { old: '100', new: '120' } }),
            }),
          ]);
        }
        expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Post',
          operation: 'updateMany',
          unidentified: 1,
        }),
      ]);
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
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a row another transaction moves out of the where of an updateMany between the read and the update as updated, and reports as row-identification that the updateMany updated fewer rows than it found again', async () => {
      await seedPost('moved-out');
      await seedPost('stays');

      const outcome = await interleave(barrier, postFindMany, {
        operation: () => readCommitted((tx) => tx.post.updateMany({ ...unpublished, data: { title: '120' } })),
        interleaved: () => other.post.update({ where: { id: 'moved-out' }, data: { published: true } }),
      });

      expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 1 } });
      expect(await postOf('moved-out')).toMatchObject({ title: '100', published: true });
      expect(await postRecords('moved-out')).toEqual([
        expect.objectContaining({
          action: 'update',
          before: expect.objectContaining({ title: '100', published: false }),
          after: expect.objectContaining({ title: '100', published: true }),
        }),
      ]);
      expect(await postRecords('stays')).toEqual([expect.objectContaining({ action: 'update' })]);
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Post',
          operation: 'updateMany',
          unidentified: 1,
        }),
      ]);
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
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Post',
          operation: 'deleteMany',
          unidentified: 1,
        }),
      ]);
    });

    it('reports as row-identification, and does not record, a row another transaction inserts into the where of a deleteMany between the read and the delete, which deletes it', async () => {
      await seedPost('read-1');

      const outcome = await interleave(barrier, postFindMany, {
        operation: () => readCommitted((tx) => tx.post.deleteMany(unpublished)),
        interleaved: () => seedPost('inserted'),
      });

      expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 2 } });
      expect(await postOf('inserted')).toBeNull();
      expect(await postRecords('inserted')).toEqual([]);
      expect(await postRecords('read-1')).toEqual([expect.objectContaining({ action: 'delete' })]);
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Post',
          operation: 'deleteMany',
          unidentified: 1,
        }),
      ]);
    });
  });

  it('records only the child a nested to-many create inserts, by the key the extension gives it, when another transaction inserts a child under the parent while it runs, reading no child before the write', async () => {
    await seedPost('existing-child');

    const outcome = await interleave(barrier, userFindUnique, {
      operation: () =>
        readCommitted((tx) =>
          tx.user.update({ where: { id: authorId }, data: { posts: { create: { title: 'created' } } } }),
        ),
      interleaved: () => seedPost('inserted-child', { title: 'by the other' }),
    });

    expect(outcome.operation.status).toBe('fulfilled');
    const created = await other.post.findFirstOrThrow({ where: { title: 'created' } });
    expect(await postRecords(created.id)).toEqual([expect.objectContaining({ action: 'create', before: null })]);
    expect(await postRecords('inserted-child')).toEqual([]);
    expect(await postRecords('existing-child')).toEqual([]);
    const insert = queries.findIndex((query) => /^INSERT INTO "public"\."posts"/.test(query));
    expect(insert).toBeGreaterThan(-1);
    expect(queries.slice(0, insert).some((query) => /FROM "public"\."posts"/.test(query))).toBe(false);
  });

  describe('a nested to-many create whose row the extension gives no key, told apart by the children the parent held before the write', () => {
    const createChild = () => ({ where: { id: authorId }, data: { autoIncChildren: { create: {} } } });
    const insertForeignChild = () => other.autoIncChild.create({ data: { parentId: authorId } });
    const childIds = async () =>
      (await other.autoIncChild.findMany({ where: { parentId: authorId }, orderBy: { id: 'asc' } })).map(
        ({ id }) => id,
      );
    const childRecords = () => other.auditLog.findMany({ where: { entityType: 'AutoIncChild' } });

    it('records no child as created, and reports its own child as row-identification, when another transaction inserts a child under the parent between the read of its children and the write', async () => {
      const outcome = await interleave(barrier, autoIncChildFindMany, {
        operation: () => readCommitted((tx) => tx.user.update(createChild())),
        interleaved: insertForeignChild,
      });

      expect(outcome.operation.status).toBe('fulfilled');
      expect(await childIds()).toHaveLength(2);
      expect(await childRecords()).toEqual([]);
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'AutoIncChild',
          operation: 'create',
          unidentified: 1,
        }),
      ]);
    });

    it('fails with AuditIncompleteError and rolls the write back under an atomic write when another transaction inserts a child under the parent between the read of its children and the write', async () => {
      const outcome = await interleave(barrier, autoIncChildFindMany, {
        operation: () => asActor(() => atomicPrisma.user.update(createChild())),
        interleaved: insertForeignChild,
      });

      expect(outcome.operation).toEqual({ status: 'rejected', reason: expect.any(AuditIncompleteError) });
      const [foreign] = await childIds();
      expect(await childIds()).toEqual([foreign]);
      expect(await childRecords()).toEqual([]);
      expect(await other.auditLog.count()).toBe(0);
    });
  });
});
