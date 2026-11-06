/**
 * A `$transaction` opened on the client a `$transaction` callback receives runs nested in that
 * transaction, as a savepoint (Prisma 7.5 and later). Its audited writes are audited in the
 * enclosing transaction and commit with it; when it rolls back to its savepoint, the writes made
 * while it was open, through its client or the enclosing one, are reported `not-committed` and
 * leave no audit row.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditLogWriter, AuditObserver, WriteMode } from '@kuruwic/prisma-audit';
import { AuditRollbackError, createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { opensNestedTransactions } from './helpers/prisma-features.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-transaction-actor' },
};

const userData = (email: string) => ({ email, name: email, password: 'secret123' });

describe.runIf(opensNestedTransactions(Prisma.prismaVersion.client))(
  'a transaction nested in a $transaction callback',
  () => {
    let basePrisma: PrismaClient;

    beforeEach(async () => {
      basePrisma = createBasePrisma();
      await cleanDatabase(basePrisma);
    });

    afterEach(async () => {
      await basePrisma.$disconnect();
    });

    const auditedClient = (mode: WriteMode, writer?: AuditLogWriter) => {
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn<AuditObserver>();
      const prisma = createAuditClient(basePrisma, {
        ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
        write: { mode, ...(writer ? { writer } : {}) },
        observer,
      });
      return { prisma, provider, observer };
    };

    const emails = async () =>
      (await basePrisma.user.findMany({ orderBy: { email: 'asc' } })).map((user) => user.email);

    const auditedEmails = async () =>
      (await basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } }))
        .map((log) => (log.after as { email: string }).email)
        .sort();

    describe.each(['atomic', 'deferred'] as const)('under %s', (mode) => {
      it('audits a write of its callback in the enclosing transaction, which commits it', async () => {
        const { prisma, provider, observer } = auditedClient(mode);

        await provider.runAsync(testActor, () =>
          prisma.$transaction(async (tx) => {
            await tx.user.create({ data: userData('outer@example.com') });
            await tx.$transaction(async (nested) => {
              await nested.user.create({ data: userData('nested@example.com') });
            });
          }),
        );
        await flushAllPendingWrites();

        expect(await emails()).toEqual(['nested@example.com', 'outer@example.com']);
        expect(await auditedEmails()).toEqual(['nested@example.com', 'outer@example.com']);
        expect(observer.mock.calls.map(([outcome]) => outcome.status)).toEqual(['complete', 'complete']);
      });

      it.each(['its own', 'the enclosing'] as const)(
        "reports a write made through %s transaction's client while it was open not committed, and leaves no audit row for it, when it rolls back to its savepoint",
        async (client) => {
          const { prisma, provider, observer } = auditedClient(mode);
          const nestedError = new Error('the nested callback failed');

          await provider.runAsync(testActor, () =>
            prisma.$transaction(async (tx) => {
              await tx.user.create({ data: userData('outer@example.com') });
              await expect(
                tx.$transaction(async (nested) => {
                  await (client === 'its own' ? nested : tx).user.create({ data: userData('nested@example.com') });
                  throw nestedError;
                }),
              ).rejects.toBe(nestedError);
            }),
          );
          await flushAllPendingWrites();

          expect(await emails()).toEqual(['outer@example.com']);
          expect(await auditedEmails()).toEqual(['outer@example.com']);
          expect(observer.mock.calls.map(([outcome]) => outcome.status).sort()).toEqual(['complete', 'not-committed']);
        },
      );

      it('rolls back only itself with AuditRollbackError when its callback catches a failed audit write, and the enclosing transaction commits', async () => {
        const writerError = new Error('audit write failed');
        let failWrites = false;
        const { prisma, provider } = auditedClient(mode, async (records, { defaultWrite }) => {
          if (failWrites) {
            throw writerError;
          }
          await defaultWrite(records);
        });
        let caught: unknown;

        await provider.runAsync(testActor, () =>
          prisma.$transaction(async (tx) => {
            await tx.user.create({ data: userData('outer@example.com') });
            const nestedOutcome = tx.$transaction(async (nested) => {
              failWrites = true;
              await nested.user.create({ data: userData('nested@example.com') }).catch((error: unknown) => {
                caught = error;
              });
              failWrites = false;
            });
            await expect(nestedOutcome).rejects.toBeInstanceOf(AuditRollbackError);
            await expect(nestedOutcome).rejects.toMatchObject({ cause: writerError });
            await tx.user.create({ data: userData('after@example.com') });
          }),
        );
        await flushAllPendingWrites();

        expect(caught).toBe(writerError);
        expect(await emails()).toEqual(['after@example.com', 'outer@example.com']);
        expect(await auditedEmails()).toEqual(['after@example.com', 'outer@example.com']);
      });

      it('runs a batch $transaction of the callback client as a nested transaction, auditing its writes', async () => {
        const { prisma, provider } = auditedClient(mode);

        await provider.runAsync(testActor, () =>
          prisma.$transaction(async (tx) => {
            await tx.$transaction([
              tx.user.create({ data: userData('first@example.com') }),
              tx.user.create({ data: userData('second@example.com') }),
            ]);
          }),
        );
        await flushAllPendingWrites();

        expect(await emails()).toEqual(['first@example.com', 'second@example.com']);
        expect(await auditedEmails()).toEqual(['first@example.com', 'second@example.com']);
      });
    });
  },
);
