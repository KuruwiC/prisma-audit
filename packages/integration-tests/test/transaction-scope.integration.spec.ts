/**
 * An interactive `$transaction` started on the audited client, or on a client derived from it by
 * `$extends`, is the transaction of every audited operation inside its callback, whether or not an
 * audit context is set when `$transaction` is called. The operations and their audit rows commit
 * and roll back with it: an awaited audit is written in it, an audit that is not awaited is written
 * once it has committed.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it } from 'vitest';
import { createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

const actor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'transaction-scope-actor', name: 'Scope Actor' },
};

describe('Interactive $transaction scope', () => {
  const context = setupTestContext();

  const createAudited = (awaitWrite: boolean) => {
    const raw = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(raw, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      performance: { awaitWrite },
      fetchBefore: { update: true },
    });
    const dispose = async () => {
      await prisma.$disconnect();
      await raw.$disconnect();
    };
    return { prisma, provider, dispose };
  };

  const userEmails = async () =>
    (await context.basePrisma.user.findMany({ select: { email: true }, orderBy: { email: 'asc' } })).map(
      (user) => user.email,
    );
  const auditRowCount = () => context.basePrisma.auditLog.count();

  const rollback = new Error('the caller rolls back');

  describe.each([
    { awaitWrite: true, audit: 'an awaited audit' },
    { awaitWrite: false, audit: 'an audit written after commit' },
  ])('with $audit', ({ awaitWrite }) => {
    it('rolls back the write and its audit when the audit context is set inside the callback', async () => {
      const audited = createAudited(awaitWrite);
      try {
        await expect(
          audited.prisma.$transaction(async (tx) => {
            await audited.provider.runAsync(actor, () =>
              tx.user.create({ data: { email: 'inside@example.com', name: 'Inside' } }),
            );
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        await flushAllPendingWrites();

        expect(await userEmails()).toEqual([]);
        expect(await auditRowCount()).toBe(0);
      } finally {
        await audited.dispose();
      }
    });

    it('keeps the write and its audit out of sight of other connections until commit when the audit context is set inside the callback', async () => {
      const audited = createAudited(awaitWrite);
      let seenBeforeCommit: { readonly users: number; readonly auditRows: number } | undefined;
      try {
        await audited.prisma.$transaction(async (tx) => {
          await audited.provider.runAsync(actor, () =>
            tx.user.create({ data: { email: 'inside@example.com', name: 'Inside' } }),
          );
          await flushAllPendingWrites();
          seenBeforeCommit = { users: await context.basePrisma.user.count(), auditRows: await auditRowCount() };
        });
        await flushAllPendingWrites();

        expect(seenBeforeCommit).toEqual({ users: 0, auditRows: 0 });
        expect(await userEmails()).toEqual(['inside@example.com']);
        expect(await auditRowCount()).toBe(1);
      } finally {
        await audited.dispose();
      }
    });

    it('rolls back the write and its audit inside a transaction of a client derived from the audited client', async () => {
      const audited = createAudited(awaitWrite);
      const derived = audited.prisma.$extends({ name: 'derived' });
      try {
        await expect(
          audited.provider.runAsync(actor, () =>
            derived.$transaction(async (tx) => {
              await tx.user.create({ data: { email: 'derived@example.com', name: 'Derived' } });
              throw rollback;
            }),
          ),
        ).rejects.toBe(rollback);
        await flushAllPendingWrites();

        expect(await userEmails()).toEqual([]);
        expect(await auditRowCount()).toBe(0);
      } finally {
        await audited.dispose();
      }
    });
  });

  it('runs an awaited audit of a row the transaction has locked inside that transaction', async () => {
    const audited = createAudited(true);
    try {
      const user = await context.basePrisma.user.create({ data: { email: 'locked@example.com', name: 'Before' } });

      await audited.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { name: 'Locked' } });
        await audited.provider.runAsync(actor, () =>
          tx.user.update({ where: { id: user.id }, data: { name: 'Audited' } }),
        );
      });

      expect((await context.basePrisma.user.findUnique({ where: { id: user.id } }))?.name).toBe('Audited');
      expect(await context.basePrisma.auditLog.count({ where: { entityId: user.id, action: 'update' } })).toBe(1);
    } finally {
      await audited.dispose();
    }
  });
});
