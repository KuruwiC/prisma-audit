/**
 * Integration Test: a model method an extension applied to the audited client adds
 *
 * A model component (`$extends({ model: { user: { signUp } } })`) calls the model's delegate
 * through `Prisma.getExtensionContext(this)`. On the audited client the write it makes is bound to
 * that client, outside any transaction; called as `tx.user.signUp()` inside `$transaction`, it is
 * bound to that transaction, and its audit row commits and rolls back with it.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'model-extension-binding-actor' },
};

describe('a model method an extension applied to the audited client adds', () => {
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();

  const createClient = (base: PrismaClient) =>
    createAuditClient(base, testAuditOptions(provider, { Prisma, schema: auditSchema })).$extends({
      model: {
        user: {
          async signUp(email: string) {
            return Prisma.getExtensionContext(this).create({
              data: { email, name: 'Signed up', password: 'secret123' },
            });
          },
        },
      },
    });

  let prisma: ReturnType<typeof createClient>;

  beforeAll(() => {
    basePrisma = createBasePrisma();
    prisma = createClient(basePrisma);
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

  it('audits the write of a model method called on the audited client outside any transaction', async () => {
    const user = await provider.runAsync(testActor, () => prisma.user.signUp('outside@example.com'));

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });

  it('audits the write of a model method called on the client a $transaction callback receives in that transaction, and rolls it back with it', async () => {
    const rollback = new Error('callback rolls back');
    let auditRowsInTransaction: number | undefined;

    await expect(
      provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.signUp('inside@example.com');
          auditRowsInTransaction = await tx.auditLog.count({ where: { entityType: 'User', action: 'create' } });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    expect(auditRowsInTransaction).toBe(1);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await userCreateLogs()).toEqual([]);
  });

  it('commits the write of a model method called on the client a $transaction callback receives together with its audit row', async () => {
    const user = await provider.runAsync(testActor, () =>
      prisma.$transaction(async (tx) => tx.user.signUp('committed@example.com')),
    );

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });
});
