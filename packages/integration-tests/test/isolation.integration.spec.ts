/**
 * The `isolation` of an outcome reports what the audit knows of the transaction an operation's
 * audit reads and its write ran in: none (`no-transaction`), one opened without an isolation level
 * the audited client was given (`undeclared`), or one opened at the level declared to it
 * (`declared`): the level of the outermost `$transaction` the operation runs in, given as its
 * option or as the option of a batch `$transaction([...])`, or `write.isolationLevel` for the
 * transaction the client opens for an atomic write. A level the client's `transactionOptions` set
 * is not declared to the audit.
 */

import type { AuditContext, AuditIsolation } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import {
  AuditContextMissingError,
  type AuditObserver,
  createAuditClient,
  flushAllPendingWrites,
  type WriteMode,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { opensNestedTransactions } from './helpers/prisma-features.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const actor: AuditContext = { actor: { category: 'model', type: 'User', id: 'isolation-actor' } };

/** The one level PostgreSQL, MySQL and SQLite all accept */
const SERIALIZABLE = Prisma.TransactionIsolationLevel.Serializable;

const declared: AuditIsolation = { kind: 'declared', level: SERIALIZABLE };
const undeclared: AuditIsolation = { kind: 'undeclared' };
const noTransaction: AuditIsolation = { kind: 'no-transaction' };

const userData = (email: string) => ({ email, name: email });

describe('the isolation an outcome reports', () => {
  const basePrisma = createBasePrisma();
  const defaultLevelPrisma = createBasePrisma({ transactionOptions: { isolationLevel: SERIALIZABLE } });
  const provider = createAsyncLocalStorageProvider();
  const observer = vi.fn<AuditObserver>();

  const auditedClient = (
    base: typeof basePrisma | typeof defaultLevelPrisma,
    write: { readonly mode: WriteMode; readonly isolationLevel?: string },
  ) => createAuditClient(base, { ...testAuditOptions(provider, { Prisma, schema: auditSchema }), write, observer });

  const asActor = <T>(run: () => Promise<T>) => provider.runAsync(actor, run);

  const isolations = async () => {
    await flushAllPendingWrites();
    return observer.mock.calls.map(([outcome]) => outcome.isolation);
  };

  afterAll(async () => {
    await basePrisma.$disconnect();
    await defaultLevelPrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
    observer.mockClear();
  });

  describe.each(['awaited', 'deferred'] as const)('a %s write outside any transaction', (mode) => {
    it('is no-transaction, audited or not', async () => {
      const prisma = auditedClient(basePrisma, { mode, isolationLevel: SERIALIZABLE });

      await asActor(() => prisma.user.create({ data: userData('audited@example.com') }));
      await createAuditClient(basePrisma, {
        ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
        write: { mode },
        requireContext: false,
        observer,
      }).user.create({ data: userData('unaudited@example.com') });

      expect(observer.mock.calls.map(([{ status }]) => status)).toEqual(['complete', 'unaudited']);
      expect(await isolations()).toEqual([noTransaction, noTransaction]);
    });
  });

  describe.each(['atomic', 'awaited', 'deferred'] as const)('a %s write in a $transaction', (mode) => {
    it('is undeclared when the $transaction declares no isolation level', async () => {
      const prisma = auditedClient(basePrisma, { mode });

      await asActor(() => prisma.$transaction((tx) => tx.user.create({ data: userData('a@example.com') })));

      expect(await isolations()).toEqual([undeclared]);
    });

    it('is the level the $transaction declares', async () => {
      const prisma = auditedClient(basePrisma, { mode });

      await asActor(() =>
        prisma.$transaction((tx) => tx.user.create({ data: userData('a@example.com') }), {
          isolationLevel: SERIALIZABLE,
        }),
      );

      expect(await isolations()).toEqual([declared]);
    });

    it('is the level a batch $transaction declares, and undeclared for a batch that declares none', async () => {
      const prisma = auditedClient(basePrisma, { mode });

      await asActor(async () => {
        await prisma.$transaction([prisma.user.create({ data: userData('a@example.com') })], {
          isolationLevel: SERIALIZABLE,
        });
        await prisma.$transaction([prisma.user.create({ data: userData('b@example.com') })]);
      });

      expect(await isolations()).toEqual([declared, undeclared]);
    });

    it('is undeclared on a client whose transactionOptions set the level, which the audit does not see', async () => {
      const prisma = auditedClient(defaultLevelPrisma, { mode });

      await asActor(() => prisma.$transaction((tx) => tx.user.create({ data: userData('a@example.com') })));

      expect(await isolations()).toEqual([undeclared]);
    });

    it("is the $transaction's, not write.isolationLevel, which only declares the transaction the client opens", async () => {
      const prisma = auditedClient(basePrisma, { mode, isolationLevel: SERIALIZABLE });

      await asActor(() => prisma.$transaction((tx) => tx.user.create({ data: userData('a@example.com') })));

      expect(await isolations()).toEqual([undeclared]);
    });

    describe.runIf(opensNestedTransactions(Prisma.prismaVersion.client))('nested in another', () => {
      it.each([
        { outer: SERIALIZABLE, nested: undefined, expected: declared },
        { outer: undefined, nested: SERIALIZABLE, expected: undeclared },
      ])(
        'is that of the outermost transaction (declaring $outer) for the writes in both, whatever the nested one declares ($nested)',
        async ({ outer, nested, expected }) => {
          const prisma = auditedClient(basePrisma, { mode });
          const optionsOf = (isolationLevel: typeof SERIALIZABLE | undefined) =>
            isolationLevel === undefined ? undefined : { isolationLevel };

          await asActor(() =>
            prisma.$transaction(async (tx) => {
              await tx.user.create({ data: userData('outer@example.com') });
              await tx.$transaction(async (inner) => {
                await inner.user.create({ data: userData('nested@example.com') });
              }, optionsOf(nested));
            }, optionsOf(outer)),
          );

          expect(await isolations()).toEqual([expected, expected]);
        },
      );

      it('is that of the outermost transaction for a batch nested in it, whatever the batch declares', async () => {
        const prisma = auditedClient(basePrisma, { mode });

        await asActor(() =>
          prisma.$transaction(async (tx) => {
            await tx.$transaction([tx.user.create({ data: userData('nested-batch@example.com') })], {
              isolationLevel: SERIALIZABLE,
            });
          }),
        );

        expect(await isolations()).toEqual([undeclared]);
      });
    });
  });

  describe('an atomic write outside any transaction, in the transaction the client opens for it', () => {
    it('is the level write.isolationLevel declares', async () => {
      const prisma = auditedClient(basePrisma, { mode: 'atomic', isolationLevel: SERIALIZABLE });

      await asActor(() => prisma.user.create({ data: userData('a@example.com') }));

      expect(await isolations()).toEqual([declared]);
    });

    it('is the level write.isolationLevel declares for a write on the audited client inside a $transaction callback, which runs outside that transaction', async () => {
      const prisma = auditedClient(basePrisma, { mode: 'atomic', isolationLevel: SERIALIZABLE });

      await asActor(() =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: userData('in-callback@example.com') });
          await prisma.user.create({ data: userData('outer-client@example.com') });
        }),
      );

      expect(
        observer.mock.calls.map(([outcome]) => ({ status: outcome.status, isolation: outcome.isolation })),
      ).toEqual([
        { status: 'complete', isolation: declared },
        { status: 'complete', isolation: undeclared },
      ]);
    });

    it('is no-transaction for an atomic write without an audit context, for which the client opens none, rejected or run unaudited', async () => {
      const prisma = auditedClient(basePrisma, { mode: 'atomic', isolationLevel: SERIALIZABLE });
      const unauditedPrisma = createAuditClient(basePrisma, {
        ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
        write: { mode: 'atomic', isolationLevel: SERIALIZABLE },
        requireContext: false,
        observer,
      });

      await expect(prisma.user.create({ data: userData('rejected@example.com') })).rejects.toThrow(
        AuditContextMissingError,
      );
      await unauditedPrisma.user.create({ data: userData('unaudited@example.com') });

      expect(
        observer.mock.calls.map(([outcome]) => ({ status: outcome.status, isolation: outcome.isolation })),
      ).toEqual([
        { status: 'not-committed', isolation: noTransaction },
        { status: 'unaudited', isolation: noTransaction },
      ]);
    });

    it('is undeclared without write.isolationLevel, the client opening it at its default level', async () => {
      const prisma = auditedClient(basePrisma, { mode: 'atomic' });
      const defaultLevel = auditedClient(defaultLevelPrisma, { mode: 'atomic' });

      await asActor(async () => {
        await prisma.user.create({ data: userData('a@example.com') });
        await defaultLevel.user.create({ data: userData('b@example.com') });
      });

      expect(await isolations()).toEqual([undeclared, undeclared]);
    });
  });
});
