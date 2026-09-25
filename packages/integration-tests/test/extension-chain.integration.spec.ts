/**
 * Integration Tests: Extension Chain Guard
 *
 * Prisma runs query extensions in the order they were applied, so an extension applied to the
 * base client before the audit extension sees every audited operation on its way in. Whether it
 * sees the operation a second time depends on the client the audit runs it on: the `query`
 * continuation carries on down the same chain, while a model delegate call starts a new chain
 * on the client it is made on. This spec pins how many times such an extension sees one audited
 * `user.update` in each execution scope; the per-scenario comments state where the entries come
 * from. A change that moves a count must update the number and its comment — never loosen the
 * assertion instead.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'extension-chain-actor' },
};

interface SeenOperation {
  readonly model: string | undefined;
  readonly operation: string;
}

/**
 * Builds an audited client whose base client carries a query extension that records every
 * operation it sees, applied before the audit extension.
 */
const createClients = (databaseUrl: string, awaitWrite: boolean) => {
  const rawBasePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const seen: SeenOperation[] = [];

  const basePrisma = rawBasePrisma.$extends({
    name: 'operation-recorder',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          seen.push({ model, operation });
          return query(args);
        },
      },
    },
  });

  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: { User: defineEntity({ type: 'User' }) },
    performance: { awaitWrite },
  });

  const userUpdatesSeen = () => seen.filter((call) => call.model === 'User' && call.operation === 'update');

  return { rawBasePrisma, prisma, provider, seen, userUpdatesSeen };
};

type Clients = ReturnType<typeof createClients>;

describe('Extension Chain Guard', () => {
  let awaited: Clients;
  let detached: Clients;

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');
    awaited = createClients(databaseUrl, true);
    detached = createClients(databaseUrl, false);
  });

  afterAll(async () => {
    await awaited.prisma.$disconnect();
    await awaited.rawBasePrisma.$disconnect();
    await detached.prisma.$disconnect();
    await detached.rawBasePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(awaited.rawBasePrisma);
    awaited.seen.length = 0;
    detached.seen.length = 0;
  });

  const createUser = (clients: Clients, email: string) =>
    clients.provider.runAsync(testActor, () =>
      clients.prisma.user.create({ data: { email, name: 'Before', password: 'secret123' } }),
    );

  const auditRowsForUpdate = (clients: Clients) =>
    clients.rawBasePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'update' } });

  it('an update in the implicit transaction (awaitWrite: true, outside any transaction) reaches the extension twice', async () => {
    const user = await createUser(awaited, 'implicit-transaction@example.com');
    awaited.seen.length = 0;

    await awaited.provider.runAsync(testActor, () =>
      awaited.prisma.user.update({ where: { id: user.id }, data: { name: 'After' } }),
    );

    // 1. the caller's call, on its way in through the base client's chain to the audit extension
    // 2. the audit extension's call on the implicit transaction client, which was opened on the
    //    base client after interception and so starts a new chain that includes this extension
    expect(awaited.userUpdatesSeen()).toHaveLength(2);
    expect(await auditRowsForUpdate(awaited)).toHaveLength(1);
  });

  it('an update outside any transaction with awaitWrite: false reaches the extension once', async () => {
    const user = await createUser(detached, 'detached-write@example.com');
    detached.seen.length = 0;

    await detached.provider.runAsync(testActor, () =>
      detached.prisma.user.update({ where: { id: user.id }, data: { name: 'After' } }),
    );
    await flushAllPendingWrites();

    // 1. the caller's call; the audit extension continues it through `query` on the same chain
    expect(detached.userUpdatesSeen()).toHaveLength(1);
    expect(await auditRowsForUpdate(detached)).toHaveLength(1);
  });

  it('an update inside an explicit $transaction reaches the extension once', async () => {
    const user = await createUser(awaited, 'explicit-transaction@example.com');
    awaited.seen.length = 0;

    await awaited.provider.runAsync(testActor, () =>
      awaited.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { name: 'After' } });
      }),
    );

    // 1. the caller's call on its interactive transaction client; the audit extension continues
    //    it through `query`, which is already bound to that client
    expect(awaited.userUpdatesSeen()).toHaveLength(1);
    expect(await auditRowsForUpdate(awaited)).toHaveLength(1);
  });
});
