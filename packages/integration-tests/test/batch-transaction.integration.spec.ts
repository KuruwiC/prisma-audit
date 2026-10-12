/**
 * A batch `$transaction([...])` stays all-or-nothing for the caller, as on a client without the
 * audit extension. With `openImplicitTransaction`, when an audit can be awaited, the batch runs as
 * one interactive transaction on the client it was called on: its operations run in order,
 * awaited audit rows are written in it, and a failure of any operation, of the build of any
 * operation's audit rows, or of an awaited audit write the policy rethrows rolls back every
 * operation of the batch together with its audit rows. Otherwise Prisma runs the batch itself.
 *
 * Each case runs the same batch on a plain `PrismaClient` first, from the same seeded rows, and
 * expects the audited client to leave the same rows and to settle the same way, with the same
 * results in the same order. A batch that never settles is detected by a timer raced inside the
 * test; the plain run is the baseline, so it must settle before the two are compared.
 */

import type { AuditContext, AuditRecord, WriteContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { cleanDatabase, createBasePrisma, setupTestContext, testAggregateMapping } from './helpers/setup.js';

const actor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'batch-transaction-actor', name: 'Batch Actor' },
};

/** How long a batch may take before the test calls it unsettled; every batch here settles well within it */
const SETTLE_WITHIN_MS = 5000;

type Outcome =
  | { readonly status: 'resolved'; readonly results: unknown }
  | { readonly status: 'rejected'; readonly code: string | undefined; readonly error: unknown }
  | { readonly status: 'unsettled' };

const settle = async (batch: Promise<unknown>): Promise<Outcome> => {
  let timer: NodeJS.Timeout | undefined;
  const unsettled = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unsettled' }), SETTLE_WITHIN_MS);
  });
  const settled = batch.then(
    (results): Outcome => ({ status: 'resolved', results }),
    (error: unknown): Outcome => ({
      status: 'rejected',
      code: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
      error,
    }),
  );
  try {
    return await Promise.race([settled, unsettled]);
  } finally {
    clearTimeout(timer);
  }
};

/** The outcome without the error object, whose message carries the call site */
const comparable = (outcome: Outcome) =>
  outcome.status === 'rejected' ? { status: outcome.status, code: outcome.code } : outcome;

interface Seeded {
  readonly ownerId: string;
}

type BatchOf = (client: PrismaClient, seeded: Seeded) => Prisma.PrismaPromise<unknown>[];

interface AuditedClientOptions {
  readonly awaitWrite?: boolean;
  readonly awaitWriteIf?: (modelName: string) => boolean;
  readonly writer?: (records: AuditRecord[], context: WriteContext<PrismaClient>) => Promise<void>;
  readonly transactionOptions?: { readonly timeout: number };
  readonly openImplicitTransaction?: boolean;
}

type BatchOptions = { readonly isolationLevel?: Prisma.TransactionIsolationLevel };

describe('Batch $transaction under the audit extension', () => {
  const context = setupTestContext();

  const createAudited = (options: AuditedClientOptions) => {
    const raw = createBasePrisma(options.transactionOptions ? { transactionOptions: options.transactionOptions } : {});
    const provider = createAsyncLocalStorageProvider();
    const observer = vi.fn();
    const prisma = createAuditClient(raw, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: testAggregateMapping,
      performance: {
        awaitWrite: options.awaitWrite,
        ...(options.awaitWriteIf ? { awaitWriteIf: options.awaitWriteIf } : {}),
        openImplicitTransaction: options.openImplicitTransaction,
      },
      fetchBefore: { update: true },
      errorHandling: { observer },
      ...(options.writer ? { hooks: { writer: options.writer } } : {}),
    });
    const dispose = async () => {
      await prisma.$disconnect();
      await raw.$disconnect();
    };
    return { prisma, provider, observer, dispose };
  };

  const seed = async (): Promise<Seeded> => {
    const owner = await context.basePrisma.user.create({
      data: { email: 'owner@example.com', name: 'Owner', password: 'secret123' },
    });
    await context.basePrisma.user.create({
      data: { email: 'taken@example.com', name: 'Taken', password: 'secret123' },
    });
    return { ownerId: owner.id };
  };

  const committedRows = async () => ({
    users: await context.basePrisma.user.findMany({ select: { email: true, name: true }, orderBy: { email: 'asc' } }),
    posts: await context.basePrisma.post.findMany({ select: { title: true }, orderBy: { title: 'asc' } }),
  });

  const auditRows = async () =>
    (
      await context.basePrisma.auditLog.findMany({
        select: { entityType: true, action: true, aggregateType: true },
        orderBy: [{ entityType: 'asc' }, { aggregateType: 'asc' }],
      })
    ).map((row) => `${row.entityType}.${row.action} under ${row.aggregateType}`);

  const runPlain = async (batchOf: BatchOf, options?: BatchOptions) => {
    await cleanDatabase(context.basePrisma);
    const seeded = await seed();
    const outcome = await settle(context.basePrisma.$transaction(batchOf(context.basePrisma, seeded), options));
    return { outcome, rows: await committedRows() };
  };

  const runAudited = async (audited: ReturnType<typeof createAudited>, batchOf: BatchOf, options?: BatchOptions) => {
    await cleanDatabase(context.basePrisma);
    const seeded = await seed();
    const outcome = await settle(
      audited.provider.runAsync(actor, () => audited.prisma.$transaction(batchOf(audited.prisma, seeded), options)),
    );
    await flushAllPendingWrites();
    return { outcome, rows: await committedRows(), audits: await auditRows() };
  };

  const expectSameAsPlain = async (
    audited: ReturnType<typeof createAudited>,
    batchOf: BatchOf,
    options?: BatchOptions,
  ) => {
    const plain = await runPlain(batchOf, options);
    expect(plain.outcome.status).not.toBe('unsettled');
    const result = await runAudited(audited, batchOf, options);
    expect(comparable(result.outcome)).toEqual(comparable(plain.outcome));
    expect(result.rows).toEqual(plain.rows);
    return result;
  };

  const createA = (client: PrismaClient) =>
    client.user.create({ data: { email: 'a@example.com', name: 'A' }, select: { email: true, name: true } });
  const createTaken = (client: PrismaClient) =>
    client.user.create({ data: { email: 'taken@example.com', name: 'Duplicate' }, select: { email: true } });

  describe('when an audit is awaited, with openImplicitTransaction', () => {
    it("rolls back every operation of the batch when one operation's write fails", async () => {
      const audited = createAudited({ openImplicitTransaction: true, awaitWrite: true });
      try {
        for (const batchOf of [
          (client: PrismaClient) => [createA(client), createTaken(client)],
          (client: PrismaClient) => [createTaken(client), createA(client)],
        ]) {
          const result = await expectSameAsPlain(audited, batchOf);
          expect(result.outcome).toMatchObject({ status: 'rejected', code: 'P2002' });
          expect(result.audits).toEqual([]);
        }
      } finally {
        await audited.dispose();
      }
    });

    it('rolls back the nested writes of an operation when another operation of the batch fails', async () => {
      const audited = createAudited({ openImplicitTransaction: true, awaitWrite: true });
      try {
        const result = await expectSameAsPlain(audited, (client, { ownerId }) => [
          client.user.update({
            where: { id: ownerId },
            data: { name: 'Renamed', posts: { create: { title: 'Nested', content: 'nested' } } },
            select: { name: true },
          }),
          createTaken(client),
        ]);
        expect(result.outcome).toMatchObject({ status: 'rejected', code: 'P2002' });
        expect(result.rows.posts).toEqual([]);
        expect(result.audits).toEqual([]);
      } finally {
        await audited.dispose();
      }
    });

    it('runs the operations the audit does not record in the same transaction, in order, with the results of a plain batch', async () => {
      const audited = createAudited({ openImplicitTransaction: true, awaitWrite: true });
      try {
        const withRead = await expectSameAsPlain(audited, (client) => [
          createA(client),
          client.user.count({ where: { email: 'a@example.com' } }),
        ]);
        expect(withRead.outcome).toEqual({ status: 'resolved', results: [{ email: 'a@example.com', name: 'A' }, 1] });
        expect(withRead.audits).toEqual(['User.create under User']);

        const withRaw = await expectSameAsPlain(audited, (client) => [
          createA(client),
          client.$executeRaw`UPDATE "users" SET name = 'Raw' WHERE email = 'a@example.com'`,
          client.$queryRaw`SELECT name FROM "users" WHERE email = 'a@example.com'`,
        ]);
        expect(withRaw.outcome).toEqual({
          status: 'resolved',
          results: [{ email: 'a@example.com', name: 'A' }, 1, [{ name: 'Raw' }]],
        });
        expect(withRaw.audits).toEqual(['User.create under User']);
      } finally {
        await audited.dispose();
      }
    });

    it('rolls back a raw statement of the batch together with the audited operations when a later operation fails', async () => {
      const audited = createAudited({ openImplicitTransaction: true, awaitWrite: true });
      try {
        const result = await expectSameAsPlain(audited, (client, { ownerId }) => [
          createA(client),
          client.$executeRaw`UPDATE "users" SET name = 'Raw' WHERE id = ${ownerId}`,
          createTaken(client),
        ]);
        expect(result.outcome).toMatchObject({ status: 'rejected', code: 'P2002' });
        expect(result.audits).toEqual([]);
      } finally {
        await audited.dispose();
      }
    });

    it('writes the audit rows of every operation in the one transaction of the batch', async () => {
      const writes: Array<Pick<WriteContext<PrismaClient>, 'handle' | 'inTransaction'>> = [];
      const audited = createAudited({
        openImplicitTransaction: true,
        awaitWrite: true,
        writer: async (records, writeContext) => {
          writes.push({ handle: writeContext.handle, inTransaction: writeContext.inTransaction });
          await writeContext.defaultWrite(records);
        },
      });
      try {
        const result = await expectSameAsPlain(audited, (client) => [
          createA(client),
          client.user.create({ data: { email: 'b@example.com', name: 'B' }, select: { email: true, name: true } }),
        ]);
        expect(result.outcome).toEqual({
          status: 'resolved',
          results: [
            { email: 'a@example.com', name: 'A' },
            { email: 'b@example.com', name: 'B' },
          ],
        });
        expect(result.audits).toEqual(['User.create under User', 'User.create under User']);
        expect(writes).toHaveLength(2);
        expect(writes.every((write) => write.inTransaction)).toBe(true);
        expect(writes[1]?.handle).toBe(writes[0]?.handle);
      } finally {
        await audited.dispose();
      }
    });

    it('rolls back every operation of the batch when only some of its models await their audit', async () => {
      const audited = createAudited({
        openImplicitTransaction: true,
        awaitWrite: false,
        awaitWriteIf: (modelName) => modelName === 'Post',
      });
      try {
        const result = await expectSameAsPlain(audited, (client, { ownerId }) => [
          client.post.create({
            data: { title: 'Awaited', content: 'awaited', authorId: ownerId },
            select: { title: true },
          }),
          createTaken(client),
        ]);
        expect(result.outcome).toMatchObject({ status: 'rejected', code: 'P2002' });
        expect(result.audits).toEqual([]);
      } finally {
        await audited.dispose();
      }
    });

    it("runs the batch at the caller's isolation level", async () => {
      const audited = createAudited({ openImplicitTransaction: true, awaitWrite: true });
      try {
        const result = await expectSameAsPlain(
          audited,
          (client) => [createA(client), client.$queryRaw`SHOW transaction_isolation`],
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        expect(result.outcome).toEqual({
          status: 'resolved',
          results: [{ email: 'a@example.com', name: 'A' }, [{ transaction_isolation: 'serializable' }]],
        });
      } finally {
        await audited.dispose();
      }
    });

    it("runs the batch as an interactive transaction bound by the client's transaction options", async () => {
      const audited = createAudited({
        openImplicitTransaction: true,
        awaitWrite: true,
        transactionOptions: { timeout: 200 },
      });
      try {
        const result = await runAudited(audited, (client) => [
          createA(client),
          client.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.5)`,
        ]);
        expect(result.outcome).toMatchObject({ status: 'rejected', code: 'P2028' });
        expect(result.rows.users.map((user) => user.email)).toEqual(['owner@example.com', 'taken@example.com']);
        expect(result.audits).toEqual([]);
      } finally {
        await audited.dispose();
      }
    });

    it('keeps the batch all-or-nothing on a client derived from the audited client', async () => {
      const audited = createAudited({ openImplicitTransaction: true, awaitWrite: true });
      const derived = audited.prisma.$extends({ name: 'derived' });
      try {
        await seed();
        const outcome = await settle(
          audited.provider.runAsync(actor, () =>
            derived.$transaction([
              derived.user.create({ data: { email: 'a@example.com', name: 'A' } }),
              derived.user.create({ data: { email: 'taken@example.com', name: 'Duplicate' } }),
            ]),
          ),
        );
        await flushAllPendingWrites();

        expect(outcome).toMatchObject({ status: 'rejected', code: 'P2002' });
        expect((await committedRows()).users.map((user) => user.email)).toEqual([
          'owner@example.com',
          'taken@example.com',
        ]);
        expect(await auditRows()).toEqual([]);
      } finally {
        await audited.dispose();
      }
    });
  });

  describe('when no audit is awaited', () => {
    it("rolls back every operation of the batch when one operation's write fails, and records nothing", async () => {
      const audited = createAudited({ awaitWrite: false });
      try {
        const result = await expectSameAsPlain(audited, (client) => [createA(client), createTaken(client)]);
        expect(result.outcome).toMatchObject({ status: 'rejected', code: 'P2002' });
        expect(result.audits).toEqual([]);
      } finally {
        await audited.dispose();
      }
    });
  });
});
