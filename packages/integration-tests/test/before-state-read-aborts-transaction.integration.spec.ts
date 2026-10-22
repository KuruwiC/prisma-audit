/**
 * Integration Test: a before-state read that fails in the database inside a PostgreSQL transaction
 *
 * PostgreSQL aborts a transaction once one of its statements fails, so the caller's update that
 * follows a failed before-state read fails too and the transaction rolls back. The read fails on a
 * value PostgreSQL rejects (a NUL byte in a text comparison), set by a query extension applied
 * before the audit extension that touches only the audit's `findUnique`.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBasePrisma, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'before-state-read-aborts-transaction-actor' },
};

describe('before-state read failing in the database inside a PostgreSQL transaction', () => {
  let rawBasePrisma: PrismaClient | undefined;

  afterEach(async () => {
    await rawBasePrisma?.$disconnect();
    rawBasePrisma = undefined;
  });

  it.each([
    { scope: 'inside an explicit $transaction', implicitTransaction: false },
    { scope: 'in the transaction implicitTransaction opens', implicitTransaction: true },
  ])("fails the caller's update and rolls it back, $scope", async ({ implicitTransaction }) => {
    const raw = createBasePrisma();
    rawBasePrisma = raw;
    const basePrisma = raw.$extends({
      name: 'rejected-before-state-read',
      query: {
        post: {
          async findUnique({ args, query }) {
            return query({ ...args, where: { ...args.where, title: 'nul\u0000byte' } });
          },
        },
      },
    });
    const observer = vi.fn<AuditErrorObserver>();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      errorObserver: observer,
      write: {
        implicitTransaction: implicitTransaction,
      },
    });
    await raw.auditLog.deleteMany();
    await raw.post.deleteMany();
    await raw.user.deleteMany();
    const user = await raw.user.create({
      data: { email: 'aborted-transaction@example.com', name: 'Owner', password: 'secret123' },
    });
    const post = await raw.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } });
    const update = { where: { id: post.id }, data: { title: 'Updated' } };

    await expect(
      provider.runAsync(testActor, () =>
        implicitTransaction ? prisma.post.update(update) : prisma.$transaction((tx) => tx.post.update(update)),
      ),
    ).rejects.toThrow('current transaction is aborted');

    expect((await raw.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Original');
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pre-fetch', modelName: 'Post', operation: 'update' }),
    );
    expect(await raw.auditLog.count()).toBe(0);
  });
});
