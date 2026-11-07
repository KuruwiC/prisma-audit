/**
 * Integration Tests: Extension Chain Guard
 *
 * Prisma runs query extensions in the order they were applied, so an extension applied to the
 * base client before the audit extension sees every audited operation on its way in, and one
 * applied to the audited client after it sees the operation once the audit extension continues
 * it through `query`. This file checks that the extension applied before the audit extension sees
 * the caller's update once outside a transaction under `mode: 'deferred'` and inside an explicit
 * `$transaction`; the audit's own reads and writes are separate queries, and the counts are of the
 * caller's update only. A change that moves a count must update the number and its comment, never
 * loosen the assertion instead. The counts for the awaited mode and for the atomic mode, whose
 * transaction is opened before the operation enters the chain, are in
 * `transaction-mode.integration.spec.ts`.
 *
 * A write an extension applied after the audit extension issues of its own is audited when it
 * issues it while continuing the caller's operation (awaited, and in the transaction the client
 * opens for an atomic write), and rejected with `AuditReentrantWriteError` when it issues it while
 * handling the audit's own read, which the audit processes.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import {
  AuditReentrantWriteError,
  createAuditClient,
  defineEntity,
  flushAllPendingWrites,
  type WriteMode,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

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
const createClients = (mode: WriteMode) => {
  const rawBasePrisma = createBasePrisma();
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
    schema: auditSchema,
    contextProvider: provider,
    entities: { User: defineEntity({ type: 'User' }) },
    write: { mode },
  });

  const userUpdatesSeen = () => seen.filter((call) => call.model === 'User' && call.operation === 'update');

  return { rawBasePrisma, prisma, provider, seen, userUpdatesSeen };
};

type Clients = ReturnType<typeof createClients>;

describe('Extension Chain Guard', () => {
  let awaited: Clients;
  let detached: Clients;
  let atomic: Clients;

  beforeAll(async () => {
    awaited = createClients('awaited');
    detached = createClients('deferred');
    atomic = createClients('atomic');
  });

  afterAll(async () => {
    for (const clients of [awaited, detached, atomic]) {
      await clients.prisma.$disconnect();
      await clients.rawBasePrisma.$disconnect();
    }
  });

  beforeEach(async () => {
    await cleanDatabase(awaited.rawBasePrisma);
    for (const clients of [awaited, detached, atomic]) {
      clients.seen.length = 0;
    }
  });

  const createUser = (clients: Clients, email: string) =>
    clients.provider.runAsync(testActor, () =>
      clients.prisma.user.create({ data: { email, name: 'Before', password: 'secret123' } }),
    );

  const auditRowsForUpdate = (clients: Clients) =>
    clients.rawBasePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'update' } });

  describe.each([
    { scope: 'outside any transaction, written once the update has committed', clients: () => awaited },
    { scope: 'in the transaction the client opens around it for an atomic write', clients: () => atomic },
  ])('an update whose audit is awaited, $scope', ({ clients: clientsOf }) => {
    it("audits a write an extension applied after the audit extension issues while it continues the caller's operation", async () => {
      const clients = clientsOf();
      const user = await createUser(clients, 'continued-caller@example.com');
      const companion = await createUser(clients, 'continued-companion@example.com');
      const later = clients.prisma.$extends({
        name: 'later-companion-writer',
        query: {
          user: {
            async update({ args, query }) {
              await clients.prisma.user.update({ where: { id: companion.id }, data: { name: 'Companion' } });
              return query(args);
            },
          },
        },
      });

      await clients.provider.runAsync(testActor, () =>
        later.user.update({ where: { id: user.id }, data: { name: 'After' } }),
      );

      const rows = await auditRowsForUpdate(clients);
      expect(rows.map((row) => row.entityId).sort()).toEqual([user.id, companion.id].sort());
    });
  });

  it.each([
    { scope: 'under the atomic write mode', clients: () => atomic, explicitTransaction: false },
    { scope: 'inside an explicit $transaction', clients: () => awaited, explicitTransaction: true },
  ])(
    "rejects with AuditReentrantWriteError a write an extension applied after the audit extension issues while it handles the audit's own read, $scope",
    async ({ clients: clientsOf, explicitTransaction }) => {
      const clients = clientsOf();
      const user = await createUser(clients, 'read-caller@example.com');
      const companion = await createUser(clients, 'read-companion@example.com');
      const readsHandled: string[] = [];
      const rejections: unknown[] = [];
      const later = clients.prisma.$extends({
        name: 'later-read-companion-writer',
        query: {
          user: {
            async $allOperations({ operation, args, query }) {
              if (operation.startsWith('find') && readsHandled.length === 0) {
                readsHandled.push(operation);
                try {
                  await clients.prisma.user.update({ where: { id: companion.id }, data: { name: 'Companion' } });
                } catch (error) {
                  rejections.push(error);
                }
              }
              return query(args);
            },
          },
        },
      });

      const update = { where: { id: user.id }, data: { name: 'After' } };
      await clients.provider.runAsync(testActor, () =>
        explicitTransaction ? later.$transaction((tx) => tx.user.update(update)) : later.user.update(update),
      );

      expect(readsHandled).toHaveLength(1);
      expect(rejections).toEqual([expect.any(AuditReentrantWriteError)]);
      expect(await clients.rawBasePrisma.user.findUniqueOrThrow({ where: { id: companion.id } })).toMatchObject({
        name: 'Before',
      });
      const rows = await auditRowsForUpdate(clients);
      expect(rows.map((row) => row.entityId)).toEqual([user.id]);
    },
  );

  it("an update outside any transaction with mode: 'deferred' reaches the extension once", async () => {
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
