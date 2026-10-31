/**
 * Integration Test: an audit-log insert that fails in the database inside a PostgreSQL transaction
 *
 * PostgreSQL aborts a transaction once one of its statements fails, so the caller's write cannot
 * commit once the audit-log insert of an immediate write has failed in the database: the caller's
 * operation fails with the insert's error and the transaction rolls back. The insert fails on a
 * value PostgreSQL rejects (a NUL byte in a text column), set by a writer that hands the records to
 * the default write.
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
  actor: { category: 'model', type: 'User', id: 'audit-insert-aborts-transaction-actor' },
};

describe('audit-log insert failing in the database inside a PostgreSQL transaction', () => {
  let rawBasePrisma: PrismaClient | undefined;

  afterEach(async () => {
    await rawBasePrisma?.$disconnect();
    rawBasePrisma = undefined;
  });

  it.each([
    { scope: 'inside an explicit $transaction', implicitTransaction: false },
    { scope: 'in the transaction implicitTransaction opens', implicitTransaction: true },
  ])(
    "fails the caller's update when its audit-log insert fails in the database, and rolls it back, $scope",
    async ({ implicitTransaction }) => {
      const raw = createBasePrisma();
      rawBasePrisma = raw;
      const observer = vi.fn<AuditErrorObserver>();
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(raw, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
        write: {
          implicitTransaction,
          writer: (records, { defaultWrite }) =>
            defaultWrite(records.map((record) => ({ ...record, entityType: 'nul\u0000byte' }))),
        },
      });
      await raw.auditLog.deleteMany();
      await raw.post.deleteMany();
      await raw.user.deleteMany();
      const user = await raw.user.create({
        data: { email: 'aborted-audit-insert@example.com', name: 'Owner', password: 'secret123' },
      });
      const post = await raw.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } });
      const update = { where: { id: post.id }, data: { title: 'Updated' } };

      const outcome = provider.runAsync(testActor, () =>
        implicitTransaction ? prisma.post.update(update) : prisma.$transaction((tx) => tx.post.update(update)),
      );

      await expect(outcome).rejects.toThrow('invalid byte sequence');
      expect(observer).toHaveBeenCalledTimes(1);
      const [context] = observer.mock.calls[0] ?? [];
      expect(context).toEqual(expect.objectContaining({ phase: 'log-write', modelName: 'Post' }));
      await expect(outcome).rejects.toBe(context?.error);
      expect((await raw.post.findUniqueOrThrow({ where: { id: post.id } })).title).toBe('Original');
      expect(await raw.auditLog.count()).toBe(0);
    },
  );
});
