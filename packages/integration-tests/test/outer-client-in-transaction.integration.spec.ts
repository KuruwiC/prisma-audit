/**
 * Integration Test: the client a write inside an interactive `$transaction` callback is issued on
 *
 * A write issued on the outer audited client is not part of the callback's transaction, so a
 * callback that throws does not roll it back, and its audit row must not roll back either. A
 * write issued on the client the callback receives is part of the transaction, and its audit row
 * commits and rolls back with it. The audited client returns a lazy operation bound to the client
 * it was called on, and starts the query inside a scope that carries that binding from its own
 * `then`, so the audit extension sees the transaction the write runs in, not whatever
 * transaction is open around the call.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'outer-client-in-transaction-actor' },
};

describe.each([
  { mode: 'without implicitTransaction', implicitTransaction: false },
  { mode: 'with implicitTransaction', implicitTransaction: true },
])('a write inside an interactive transaction callback, $mode', ({ implicitTransaction }) => {
  let basePrisma: PrismaClient;
  let provider: ReturnType<typeof createAsyncLocalStorageProvider>;
  let prisma: ReturnType<typeof createAuditClient>;

  beforeAll(() => {
    basePrisma = createBasePrisma();
    provider = createAsyncLocalStorageProvider();
    prisma = createAuditClient(basePrisma, {
      ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
      write: { awaited: true, implicitTransaction },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
  });

  const userCreateLogs = async () => {
    await flushAllPendingWrites();
    return basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } });
  };

  it('keeps the audit row of a write on the outer client, which commits on its own, when the callback throws', async () => {
    const rollback = new Error('callback rolls back');

    await expect(
      provider.runAsync(testActor, () =>
        prisma.$transaction(async () => {
          await prisma.user.create({
            data: { email: 'outer-client@example.com', name: 'Outer', password: 'secret123' },
          });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    const user = await basePrisma.user.findUniqueOrThrow({ where: { email: 'outer-client@example.com' } });
    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });

  it('audits a write on the client the callback receives in that transaction, and rolls its audit row back with it', async () => {
    const rollback = new Error('callback rolls back');
    let auditRowsInTransaction: number | undefined;

    await expect(
      provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.user.create({ data: { email: 'tx-client@example.com', name: 'Inner', password: 'secret123' } });
          auditRowsInTransaction = await tx.auditLog.count({ where: { entityType: 'User', action: 'create' } });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    expect(auditRowsInTransaction).toBe(1);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await userCreateLogs()).toEqual([]);
  });
});
