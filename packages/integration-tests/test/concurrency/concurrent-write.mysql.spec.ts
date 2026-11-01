/**
 * Integration Test: a commit that lands between the audit's read and the write, on MySQL (InnoDB)
 * under its default isolation level, REPEATABLE READ
 *
 * Held the same way as `concurrent-write.postgresql.spec.ts`: a read barrier applied to the base
 * client before the audit extension holds the audited operation right after the audit's read,
 * while another client without the audit commits a write.
 */

import type { AuditContext, AuditContextProvider, AuditErrorContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditSchema } from '../../generated/mysql-audit/index.js';
import { Prisma, PrismaClient } from '../../generated/mysql-client/client';
import { carriedDatabaseCode, databaseCodeOf } from '../helpers/database-error-code.js';
import {
  type BarrierTarget,
  createReadBarrier,
  HELD_TRANSACTION_TIMEOUT_MS,
  interleave,
  type Settled,
} from '../helpers/read-barrier.js';
import { testAuditOptions } from '../helpers/setup.js';
import { type MySQLTestContext, setupMySQLDatabase, teardownMySQLDatabase } from '../helpers/setup-mysql.js';

const actor: AuditContext = { actor: { category: 'model', type: 'User', id: 'concurrent-writer' } };

const POST_ID = 'contended-post';

const postFindUnique: BarrierTarget = { model: 'Post', read: 'findUnique' };
const postFindMany: BarrierTarget = { model: 'Post', read: 'findMany' };

const errorCodesOf = (settled: Settled<unknown>) => {
  if (settled.status !== 'rejected' || !(settled.reason instanceof Prisma.PrismaClientKnownRequestError)) {
    return settled;
  }
  return { code: settled.reason.code, errno: databaseCodeOf(settled.reason) };
};

/**
 * The clients of a test: an audited client whose base holds the audit's reads at `barrier`, logs
 * every statement that succeeds into `queries` and reports its failures to `observer`, and the
 * other writer, a client without the audit
 */
const createClients = (
  databaseUrl: string,
  barrier: ReturnType<typeof createReadBarrier>,
  queries: string[],
  provider: AuditContextProvider,
  observer: (context: AuditErrorContext) => void,
) => {
  const rawBase = new PrismaClient({
    adapter: new PrismaMariaDb(databaseUrl),
    log: [{ emit: 'event', level: 'query' }],
  });
  rawBase.$on('query', (event) => {
    queries.push(event.query);
  });
  const base = rawBase.$extends({ name: 'read-barrier', query: barrier.query });
  const prisma = createAuditClient(base, {
    ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
    errorObserver: observer,
  });
  const other = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  return { rawBase, prisma, other };
};

describe('concurrent writes on MySQL under REPEATABLE READ: a commit between the audit read and the write', () => {
  const barrier = createReadBarrier();
  const queries: string[] = [];
  const observer = vi.fn<(context: AuditErrorContext) => void>();
  const provider = createAsyncLocalStorageProvider();

  let database: MySQLTestContext | undefined;
  let clients: ReturnType<typeof createClients> | undefined;
  let authorId = '';

  const clientsOf = () => {
    if (clients === undefined) {
      throw new Error('MySQL clients are not set up');
    }
    return clients;
  };

  const asActor = <T>(run: () => Promise<T>) => provider.runAsync(actor, run);

  type Transaction = Parameters<Parameters<ReturnType<typeof createClients>['prisma']['$transaction']>[0]>[0];

  const inDefaultTransaction = <T>(run: (tx: Transaction) => Promise<T>) =>
    asActor(() => clientsOf().prisma.$transaction(run, { timeout: HELD_TRANSACTION_TIMEOUT_MS }));

  const postRecords = (entityId: string) =>
    clientsOf().other.auditLog.findMany({ where: { entityType: 'Post', entityId, aggregateType: 'Post' } });

  const postOf = (id: string) => clientsOf().other.post.findUnique({ where: { id } });

  const seedPost = (title: string) => clientsOf().other.post.create({ data: { id: POST_ID, title, authorId } });

  const seedUnpublishedPost = (id: string) =>
    clientsOf().other.post.create({ data: { id, title: '100', published: false, authorId } });

  beforeAll(async () => {
    database = await setupMySQLDatabase();
    clients = createClients(database.databaseUrl, barrier, queries, provider, observer);
  });

  afterAll(async () => {
    await clients?.prisma.$disconnect();
    await clients?.rawBase.$disconnect();
    await clients?.other.$disconnect();
    if (database) {
      await teardownMySQLDatabase(database);
    }
  });

  beforeEach(async () => {
    const { other } = clientsOf();
    await other.auditLog.deleteMany();
    await other.label.deleteMany();
    await other.post.deleteMany();
    await other.user.deleteMany();
    authorId = (await other.user.create({ data: { email: 'author@example.com', name: 'Author' } })).id;
    observer.mockClear();
    queries.length = 0;
  });

  it('runs a transaction that names no isolation level under REPEATABLE READ', async () => {
    await expect(clientsOf().other.$queryRaw`SELECT @@global.transaction_isolation AS level`).resolves.toEqual([
      { level: 'REPEATABLE-READ' },
    ]);
  });

  describe('documented limitation: REPEATABLE READ', () => {
    it('records the before state read ahead of a commit that lands between the read and the update in a REPEATABLE READ transaction, without an error', async () => {
      await seedPost('100');

      const outcome = await interleave(barrier, postFindUnique, {
        operation: () =>
          inDefaultTransaction((tx) => tx.post.update({ where: { id: POST_ID }, data: { title: '120' } })),
        interleaved: () => clientsOf().other.post.update({ where: { id: POST_ID }, data: { title: '110' } }),
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

  it('counts the rows an updateMany matched, including a row whose values it leaves as they are, and reports nothing', async () => {
    const { other } = clientsOf();
    // Label has no @updatedAt column, which Prisma would set on every row the update matches
    await other.label.create({ data: { id: 'changed', name: 'old' } });
    await other.label.create({ data: { id: 'unchanged', name: 'new' } });

    const outcome = await inDefaultTransaction((tx) =>
      tx.label.updateMany({ where: { id: { in: ['changed', 'unchanged'] } }, data: { name: 'new' } }),
    );

    expect(outcome).toEqual({ count: 2 });
    expect(observer).not.toHaveBeenCalled();
  });

  it('reports as row-identification that an updateMany updated fewer rows than it found again when another transaction moves a read row out of its where between the read and the update, and records no change of that row', async () => {
    await seedUnpublishedPost('moved-out');
    await seedUnpublishedPost('stays');

    const outcome = await interleave(barrier, postFindMany, {
      operation: () =>
        inDefaultTransaction((tx) => tx.post.updateMany({ where: { published: false }, data: { title: '120' } })),
      interleaved: () => clientsOf().other.post.update({ where: { id: 'moved-out' }, data: { published: true } }),
    });

    // The UPDATE reads the latest committed rows and skips the row moved out; the read after it is a consistent read
    // of the transaction's snapshot, which still holds that row as read, so its record has no change and is not written
    expect(outcome.operation).toEqual({ status: 'fulfilled', value: { count: 1 } });
    expect(await postOf('moved-out')).toMatchObject({ title: '100', published: true });
    expect(await postRecords('moved-out')).toEqual([]);
    expect(await postRecords('stays')).toEqual([expect.objectContaining({ action: 'update' })]);
    expect(observer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        phase: 'row-identification',
        modelName: 'Post',
        operation: 'updateMany',
        params: { unidentified: 1 },
      }),
    );
  });

  it('rejects an upsert, which Prisma emulates on MySQL, with a unique constraint violation when another transaction inserts its row between the read and the upsert, recording nothing', async () => {
    const outcome = await interleave(barrier, postFindUnique, {
      operation: () =>
        inDefaultTransaction((tx) =>
          tx.post.upsert({
            where: { id: POST_ID },
            create: { id: POST_ID, title: 'created', authorId },
            update: { title: '120' },
          }),
        ),
      interleaved: () => seedPost('110'),
    });

    expect(errorCodesOf(outcome.operation)).toEqual({
      code: 'P2002',
      errno: carriedDatabaseCode(Prisma.prismaVersion.client, '1062'),
    });
    // The emulation's existence check, a consistent read of the snapshot that misses the inserted row, precedes its
    // INSERT; the query log holds the statements that succeeded only
    expect(queries.some((query) => /^SELECT `posts`\.`id` FROM/.test(query))).toBe(true);
    expect((await postOf(POST_ID))?.title).toBe('110');
    expect(await postRecords(POST_ID)).toEqual([]);
  });
});
