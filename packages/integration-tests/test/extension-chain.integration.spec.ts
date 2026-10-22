/**
 * Integration Tests: Extension Chain Guard
 *
 * Prisma runs query extensions in the order they were applied, so an extension applied to the
 * base client before the audit extension sees every audited operation on its way in, and one
 * applied to the audited client after it sees the operation once the audit extension continues
 * it through `query`. The audit extension always continues the caller's operation that way, and
 * with `implicitTransaction` the transaction is opened before the operation enters the chain,
 * so each extension sees one audited `user.update` once in every execution scope. The audit's own
 * reads and writes are separate queries; the counts are of the caller's update only. A change that
 * moves a count must update the number and its comment, never loosen the assertion instead. A write
 * an extension applied after the audit extension issues of its own is audited when it issues it
 * while continuing the caller's operation, and not when it issues it while handling the audit's
 * own read.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
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
const createClients = (awaited: boolean, implicitTransaction = false) => {
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
    write: {
      awaited,
      implicitTransaction,
    },
  });

  const userUpdatesSeen = () => seen.filter((call) => call.model === 'User' && call.operation === 'update');

  return { rawBasePrisma, prisma, provider, seen, userUpdatesSeen };
};

type Clients = ReturnType<typeof createClients>;

describe('Extension Chain Guard', () => {
  let awaited: Clients;
  let detached: Clients;
  let opening: Clients;

  beforeAll(async () => {
    awaited = createClients(true);
    detached = createClients(false);
    opening = createClients(true, true);
  });

  afterAll(async () => {
    for (const clients of [awaited, detached, opening]) {
      await clients.prisma.$disconnect();
      await clients.rawBasePrisma.$disconnect();
    }
  });

  beforeEach(async () => {
    await cleanDatabase(awaited.rawBasePrisma);
    for (const clients of [awaited, detached, opening]) {
      clients.seen.length = 0;
    }
  });

  const createUser = (clients: Clients, email: string) =>
    clients.provider.runAsync(testActor, () =>
      clients.prisma.user.create({ data: { email, name: 'Before', password: 'secret123' } }),
    );

  const auditRowsForUpdate = (clients: Clients) =>
    clients.rawBasePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'update' } });

  const laterRecorder = (clients: Clients) => {
    const seenLater: SeenOperation[] = [];
    const later = clients.prisma.$extends({
      name: 'later-operation-recorder',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            seenLater.push({ model, operation });
            return query(args);
          },
        },
      },
    });
    const laterUpdatesSeen = () => seenLater.filter((call) => call.model === 'User' && call.operation === 'update');
    return { later, laterUpdatesSeen };
  };

  describe.each([
    { scope: 'outside any transaction, written once the update has committed', clients: () => awaited },
    { scope: 'in the transaction implicitTransaction opens around it', clients: () => opening },
  ])('an update whose audit is awaited, $scope', ({ clients: clientsOf }) => {
    it('reaches an extension applied before the audit extension once', async () => {
      const clients = clientsOf();
      const user = await createUser(clients, 'awaited-single@example.com');
      clients.seen.length = 0;

      await clients.provider.runAsync(testActor, () =>
        clients.prisma.user.update({ where: { id: user.id }, data: { name: 'After' } }),
      );

      // 1. the caller's call, which the audit extension continues through `query` on the same chain
      expect(clients.userUpdatesSeen()).toHaveLength(1);
      expect(await auditRowsForUpdate(clients)).toHaveLength(1);
    });

    it('reaches an extension applied after the audit extension once', async () => {
      const clients = clientsOf();
      const user = await createUser(clients, 'awaited-single-later@example.com');
      const { later, laterUpdatesSeen } = laterRecorder(clients);

      await clients.provider.runAsync(testActor, () =>
        later.user.update({ where: { id: user.id }, data: { name: 'After' } }),
      );

      // 1. the caller's call, continued through `query` past the audit extension
      expect(laterUpdatesSeen()).toHaveLength(1);
      expect(await auditRowsForUpdate(clients)).toHaveLength(1);
    });

    it('in a batch $transaction reaches an extension applied before the audit extension once', async () => {
      const clients = clientsOf();
      const user = await createUser(clients, 'awaited-batch@example.com');
      clients.seen.length = 0;

      await clients.provider.runAsync(testActor, () =>
        clients.prisma.$transaction([clients.prisma.user.update({ where: { id: user.id }, data: { name: 'After' } })]),
      );

      // 1. the caller's call, in Prisma's batch, or replayed on the client of the interactive
      //    transaction the batch runs in with implicitTransaction
      expect(clients.userUpdatesSeen()).toHaveLength(1);
      expect(await auditRowsForUpdate(clients)).toHaveLength(1);
    });

    it('in a batch $transaction reaches an extension applied after the audit extension once', async () => {
      const clients = clientsOf();
      const user = await createUser(clients, 'awaited-batch-later@example.com');
      const { later, laterUpdatesSeen } = laterRecorder(clients);

      await clients.provider.runAsync(testActor, () =>
        later.$transaction([later.user.update({ where: { id: user.id }, data: { name: 'After' } })]),
      );

      // 1. the caller's call, continued through `query` past the audit extension
      expect(laterUpdatesSeen()).toHaveLength(1);
      expect(await auditRowsForUpdate(clients)).toHaveLength(1);
    });

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
    { scope: 'with implicitTransaction', clients: () => opening, explicitTransaction: false },
    { scope: 'inside an explicit $transaction', clients: () => awaited, explicitTransaction: true },
  ])(
    "does not audit a write an extension applied after the audit extension issues while it handles the audit's own read, $scope",
    async ({ clients: clientsOf, explicitTransaction }) => {
      const clients = clientsOf();
      const user = await createUser(clients, 'read-caller@example.com');
      const companion = await createUser(clients, 'read-companion@example.com');
      const readsHandled: string[] = [];
      const later = clients.prisma.$extends({
        name: 'later-read-companion-writer',
        query: {
          user: {
            async $allOperations({ operation, args, query }) {
              if (operation.startsWith('find') && readsHandled.length === 0) {
                readsHandled.push(operation);
                await clients.prisma.user.update({ where: { id: companion.id }, data: { name: 'Companion' } });
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
      expect(await clients.rawBasePrisma.user.findUniqueOrThrow({ where: { id: companion.id } })).toMatchObject({
        name: 'Companion',
      });
      const rows = await auditRowsForUpdate(clients);
      expect(rows.map((row) => row.entityId)).toEqual([user.id]);
    },
  );

  it('an update outside any transaction with awaited: false reaches the extension once', async () => {
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
