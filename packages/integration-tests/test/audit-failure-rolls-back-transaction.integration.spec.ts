/**
 * Integration Test: an audit failure that failed an operation of an interactive `$transaction`
 * rolls the transaction back, even when the callback catches it
 *
 * An immediate audit write that fails, or a build of the records that fails inside the
 * transaction, fails the operation after its write has run. A callback that catches that error and
 * resolves would otherwise commit the write without its audit rows; `$transaction` rejects with
 * `AuditRollbackError` instead, whose `cause` is the audit error, and the transaction rolls back.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { AuditRollbackError, createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'audit-failure-rolls-back-transaction-actor' },
};

describe('an audit failure the $transaction callback catches', () => {
  let basePrisma: PrismaClient;

  beforeEach(async () => {
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  const auditedClient = (overrides: { readonly failingEnricher?: boolean; readonly writerError?: Error }) => {
    const provider = createAsyncLocalStorageProvider();
    const options = testAuditOptions(provider, { Prisma, schema: auditSchema });
    const { writerError } = overrides;
    const prisma = createAuditClient(basePrisma, {
      ...options,
      write: {
        awaited: true,
        ...(writerError
          ? {
              writer: async () => {
                throw writerError;
              },
            }
          : {}),
      },
      ...(overrides.failingEnricher
        ? {
            actorContext: {
              enricher: async () => {
                throw new Error('actor enricher is broken');
              },
            },
          }
        : {}),
    });
    return { prisma, provider };
  };

  it('rolls the transaction back with AuditRollbackError when the callback catches a failed immediate audit write', async () => {
    const writerError = new Error('audit write failed');
    const { prisma, provider } = auditedClient({ writerError });
    let caught: unknown;

    const outcome = provider.runAsync(testActor, () =>
      prisma.$transaction(async (tx) => {
        await tx.user
          .create({ data: { email: 'caught@example.com', name: 'Caught', password: 'secret123' } })
          .catch((error: unknown) => {
            caught = error;
          });
        return 'resolved';
      }),
    );

    await expect(outcome).rejects.toBeInstanceOf(AuditRollbackError);
    await expect(outcome).rejects.toMatchObject({ cause: writerError });
    expect(caught).toBe(writerError);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await basePrisma.auditLog.count()).toBe(0);
  });

  it('rolls the transaction back with AuditRollbackError when the callback catches a failed build of the audit records', async () => {
    const { prisma, provider } = auditedClient({ failingEnricher: true });

    const outcome = provider.runAsync(testActor, () =>
      prisma.$transaction(async (tx) => {
        await tx.user
          .create({ data: { email: 'caught@example.com', name: 'Caught', password: 'secret123' } })
          .catch(() => undefined);
      }),
    );

    await expect(outcome).rejects.toBeInstanceOf(AuditRollbackError);
    await expect(outcome).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'actor enricher is broken' }),
    });
    expect(await basePrisma.user.count()).toBe(0);
  });

  it('commits a transaction whose callback catches the failure of its own write, which the audit did not cause', async () => {
    await basePrisma.user.create({ data: { email: 'taken@example.com', name: 'Taken', password: 'secret123' } });
    const { prisma, provider } = auditedClient({});

    await provider.runAsync(testActor, () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SAVEPOINT before_duplicate`;
        await tx.user
          .create({ data: { email: 'taken@example.com', name: 'Duplicate', password: 'secret123' } })
          .catch(() => undefined);
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT before_duplicate`;
        await tx.user.create({ data: { email: 'kept@example.com', name: 'Kept', password: 'secret123' } });
      }),
    );

    expect((await basePrisma.user.findMany({ orderBy: { email: 'asc' } })).map((user) => user.email)).toEqual([
      'kept@example.com',
      'taken@example.com',
    ]);
    expect(await basePrisma.auditLog.count({ where: { entityType: 'User', action: 'create' } })).toBe(1);
  });
});
