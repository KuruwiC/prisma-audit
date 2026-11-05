/**
 * PostgreSQL aborts a transaction on a failed statement and answers its COMMIT with a rollback. A
 * `$transaction` callback that catches such a failure without a savepoint and resolves rejects,
 * its writes are reported `not-committed` and the audit rows written in it roll back with them;
 * one that rolls back to a savepoint commits as usual.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditObserver, WriteMode } from '@kuruwic/prisma-audit';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'aborted-transaction-actor' },
};

describe('a failed statement the $transaction callback catches inside a PostgreSQL transaction', () => {
  let basePrisma: PrismaClient;

  beforeEach(async () => {
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
    await basePrisma.user.create({ data: { email: 'taken@example.com', name: 'Taken', password: 'secret123' } });
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  const auditedClient = (mode: WriteMode) => {
    const provider = createAsyncLocalStorageProvider();
    const observer = vi.fn<AuditObserver>();
    const prisma = createAuditClient(basePrisma, {
      ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
      write: { mode },
      observer,
    });
    return { prisma, provider, observer };
  };

  type TransactionClient = Parameters<Parameters<ReturnType<typeof auditedClient>['prisma']['$transaction']>[0]>[0];

  const failingStatements: ReadonlyArray<{
    readonly statement: string;
    readonly fail: (tx: TransactionClient) => Promise<unknown>;
    /** What the observer receives for the transaction's writes, in order */
    readonly reported: ReadonlyArray<readonly [string, string]>;
  }> = [
    {
      statement: "the caller's audited write",
      fail: (tx) => tx.user.create({ data: { email: 'taken@example.com', name: 'Duplicate', password: 'secret123' } }),
      reported: [
        ['create', 'not-committed'],
        ['create', 'not-committed'],
      ],
    },
    { statement: 'a raw query', fail: (tx) => tx.$queryRaw`SELECT 1 / 0`, reported: [['create', 'not-committed']] },
  ];

  describe.each(['awaited', 'deferred'] as const)(
    'with audit writes under %s, written inside the transaction',
    (mode) => {
      it.each(failingStatements)(
        'rolls the transaction back, rejecting with the error PostgreSQL answers, when $statement failed',
        async ({ fail, reported }) => {
          const { prisma, provider, observer } = auditedClient(mode);

          const outcome = provider.runAsync(testActor, () =>
            prisma.$transaction(async (tx) => {
              await tx.user.create({ data: { email: 'written@example.com', name: 'Written', password: 'secret123' } });
              await fail(tx).catch(() => undefined);
              return 'resolved';
            }),
          );

          await expect(outcome).rejects.toThrow('current transaction is aborted');
          await flushAllPendingWrites();
          expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['taken@example.com']);
          expect(await basePrisma.auditLog.count()).toBe(0);
          expect(observer.mock.calls.map(([outcome]) => [outcome.operation, outcome.status])).toEqual(reported);
        },
      );
    },
  );

  it('commits a transaction whose callback rolled back to a savepoint after the failed statement', async () => {
    const { prisma, provider, observer } = auditedClient('deferred');

    await provider.runAsync(testActor, () =>
      prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { email: 'written@example.com', name: 'Written', password: 'secret123' } });
        await tx.$executeRaw`SAVEPOINT before_failure`;
        await tx.$queryRaw`SELECT 1 / 0`.catch(() => undefined);
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT before_failure`;
      }),
    );
    await flushAllPendingWrites();

    expect((await basePrisma.user.findMany({ orderBy: { email: 'asc' } })).map((user) => user.email)).toEqual([
      'taken@example.com',
      'written@example.com',
    ]);
    expect(await basePrisma.auditLog.count({ where: { entityType: 'User', action: 'create' } })).toBe(1);
    expect(observer.mock.calls.map(([reported]) => reported.status)).toEqual(['complete']);
  });
});
