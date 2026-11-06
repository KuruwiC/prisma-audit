/**
 * The audit log holds a row for exactly the writes the database committed, whatever undid the
 * others: a rollback to a savepoint the callback issues itself, a nested transaction that rolls
 * back, or PostgreSQL aborting the transaction on a statement the callback caught.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { WriteMode } from '@kuruwic/prisma-audit';
import { AuditRollbackError, createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'audit-rows-follow-commit-actor' },
};

const userData = (email: string) => ({ email, name: email, password: 'secret123' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

const objectOf = (value: unknown): object => {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${String(value)}`);
  }
  return value;
};

const intercepted = <T extends object>(
  target: T,
  overrides: Record<string, (original: AsyncMethod) => AsyncMethod>,
): T =>
  new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property);
      if (typeof value !== 'function') {
        return value;
      }
      const override = typeof property === 'string' ? overrides[property] : undefined;
      return override
        ? override(async (...args) => Reflect.apply(value, object, args))
        : (...args: unknown[]) => Reflect.apply(value, object, args);
    },
  });

/**
 * A client without the audit extension whose adapter runs each nested SAVEPOINT `delayMs` late, so
 * that what starts meanwhile on the enclosing transaction reaches the database first
 */
const createClientWithLateSavepoints = (delayMs: number) =>
  new PrismaClient({
    adapter: intercepted(new PrismaPg({ connectionString: inject('databaseUrl') }), {
      connect: (connect) => async () =>
        intercepted(objectOf(await connect()), {
          startTransaction:
            (start) =>
            async (...args) =>
              intercepted(objectOf(await start(...args)), {
                createSavepoint:
                  (create) =>
                  async (...args) => {
                    await sleep(delayMs);
                    return create(...args);
                  },
              }),
        }),
    }),
  });

describe('audit rows follow the commit of the writes they record', () => {
  let basePrisma: PrismaClient;

  beforeEach(async () => {
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  const auditedClient = (mode: WriteMode) => {
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
      write: { mode },
    });
    return { prisma, provider };
  };

  type AuditedClient = ReturnType<typeof auditedClient>['prisma'];
  type TransactionClient = Parameters<Parameters<AuditedClient['$transaction']>[0]>[0];

  const committedEmails = async () =>
    (await basePrisma.user.findMany({ orderBy: { email: 'asc' } })).map((user) => user.email);

  const auditedEmails = async () =>
    (await basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } }))
      .map((log) => (log.after as { email: string }).email)
      .sort();

  const undoings: ReadonlyArray<{
    readonly undoing: string;
    readonly run: (tx: TransactionClient) => Promise<unknown>;
  }> = [
    {
      undoing: 'a rollback to a savepoint the callback issues itself',
      run: async (tx) => {
        await tx.$executeRaw`SAVEPOINT caller_savepoint`;
        await tx.user.create({ data: userData('undone@example.com') });
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT caller_savepoint`;
      },
    },
    {
      undoing: 'a nested transaction that rolls back',
      run: (tx) =>
        tx
          .$transaction(async (nested) => {
            await nested.user.create({ data: userData('undone@example.com') });
            throw new Error('the nested callback failed');
          })
          .catch(() => undefined),
    },
  ];

  describe.each(['atomic', 'awaited', 'deferred'] as const)('under %s', (mode: WriteMode) => {
    it.each(undoings)('leaves no audit row for a write undone by $undoing', async ({ run }) => {
      const { prisma, provider } = auditedClient(mode);

      await provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: userData('kept@example.com') });
          await run(tx);
        }),
      );
      await flushAllPendingWrites();

      expect(await committedEmails()).toEqual(['kept@example.com']);
      expect(await auditedEmails()).toEqual(await committedEmails());
    });

    it('commits a write the callback started without awaiting, and its audit row, once the write has settled', async () => {
      const { prisma, provider } = auditedClient(mode);
      const events: string[] = [];

      await provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          void tx.user.create({ data: userData('unawaited@example.com') }).then(() => {
            events.push('write settled');
          });
          events.push('callback resolved');
        }),
      );
      events.push('transaction committed');
      await flushAllPendingWrites();

      expect(events).toEqual(['callback resolved', 'write settled', 'transaction committed']);
      expect(await committedEmails()).toEqual(['unawaited@example.com']);
      expect(await auditedEmails()).toEqual(['unawaited@example.com']);
    });

    it('rolls the transaction back with AuditRollbackError when the audit write of a write the callback started without awaiting fails', async () => {
      const writerError = new Error('audit write failed');
      const provider = createAsyncLocalStorageProvider();
      const prisma = createAuditClient(basePrisma, {
        ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
        write: {
          mode,
          writer: async () => {
            throw writerError;
          },
        },
      });
      const events: string[] = [];
      let caught: unknown;

      const outcome = provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          void tx.user.create({ data: userData('unawaited@example.com') }).catch((error: unknown) => {
            caught = error;
            events.push('write failed');
          });
          events.push('callback resolved');
        }),
      );

      await expect(outcome).rejects.toBeInstanceOf(AuditRollbackError);
      await expect(outcome).rejects.toMatchObject({ cause: writerError });
      expect(events).toEqual(['callback resolved', 'write failed']);
      expect(caught).toBe(writerError);
      expect(await committedEmails()).toEqual([]);
      expect(await basePrisma.auditLog.count()).toBe(0);
    });

    it('leaves an audit row for exactly the committed writes when a write starts while a nested transaction that rolls back is opening', async () => {
      // The SAVEPOINT runs late and the audit-log insert later still: a write that started while the
      // nested transaction was opening and ran its own insert on the enclosing transaction would
      // insert its audit log inside the savepoint, which the nested rollback undoes
      const latePrisma = createClientWithLateSavepoints(100);
      try {
        const provider = createAsyncLocalStorageProvider();
        const prisma = createAuditClient(latePrisma, {
          ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
          write: {
            mode,
            writer: async (records, { defaultWrite }) => {
              await sleep(200);
              await defaultWrite(records);
            },
          },
        });

        await provider.runAsync(testActor, () =>
          prisma.$transaction(
            async (tx) => {
              await Promise.all([
                tx
                  .$transaction(async (nested) => {
                    await nested.user.create({ data: userData('undone@example.com') });
                    throw new Error('the nested callback failed');
                  })
                  .catch(() => undefined),
                tx.user.create({ data: userData('kept@example.com') }),
              ]);
            },
            { timeout: 10_000 },
          ),
        );
        await flushAllPendingWrites();

        expect(await committedEmails()).not.toContain('undone@example.com');
        expect(await auditedEmails()).toEqual(await committedEmails());
      } finally {
        await latePrisma.$disconnect();
      }
    });

    it('leaves an audit row for exactly the committed writes when a write runs alongside a nested transaction that rolls back', async () => {
      const { prisma, provider } = auditedClient(mode);

      await provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await Promise.all([
            tx.user.create({ data: userData('kept@example.com') }),
            tx
              .$transaction(async (nested) => {
                await nested.user.create({ data: userData('undone@example.com') });
                throw new Error('the nested callback failed');
              })
              .catch(() => undefined),
          ]);
        }),
      );
      await flushAllPendingWrites();

      expect(await committedEmails()).not.toContain('undone@example.com');
      expect(await auditedEmails()).toEqual(await committedEmails());
    });
  });
});
