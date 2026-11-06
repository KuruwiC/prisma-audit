/**
 * The audit log holds a row for exactly the writes the database committed, whatever undid the
 * others: a rollback to a savepoint the callback issues itself, a nested transaction that rolls
 * back, or PostgreSQL aborting the transaction on a statement the callback caught.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { WriteMode } from '@kuruwic/prisma-audit';
import { AuditRollbackError, createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { afterPendingMicrotasks, createHold } from './helpers/hold.js';
import { opensNestedTransactions } from './helpers/prisma-features.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const nestedTransactions = opensNestedTransactions(Prisma.prismaVersion.client);

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'audit-rows-follow-commit-actor' },
};

const userData = (email: string) => ({ email, name: email, password: 'secret123' });

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

interface ConnectionHooks {
  /** Runs before a nested SAVEPOINT is sent, which waits for it */
  readonly beforeSavepoint?: () => Promise<void>;
  readonly afterSavepoint?: () => void;
  /** Runs after a statement of a transaction has run, before Prisma receives its result, which waits for it */
  readonly afterStatement?: (query: unknown) => Promise<void> | void;
}

/** A client without the audit extension whose adapter calls `hooks` around the statements of its transactions */
const createClientOnWatchedConnection = ({ beforeSavepoint, afterSavepoint, afterStatement }: ConnectionHooks) => {
  const statement =
    (run: AsyncMethod): AsyncMethod =>
    async (...args) => {
      const result = await run(...args);
      await afterStatement?.(args[0]);
      return result;
    };
  return new PrismaClient({
    adapter: intercepted(new PrismaPg({ connectionString: inject('databaseUrl') }), {
      connect: (connect) => async () =>
        intercepted(objectOf(await connect()), {
          startTransaction:
            (start) =>
            async (...args) =>
              intercepted(objectOf(await start(...args)), {
                queryRaw: statement,
                executeRaw: statement,
                createSavepoint:
                  (create) =>
                  async (...args) => {
                    await beforeSavepoint?.();
                    const result = await create(...args);
                    afterSavepoint?.();
                    return result;
                  },
              }),
        }),
    }),
  });
};

/** What an INSERT of the write of kept@example.com wrote, from the statement the adapter ran */
const keptWriteInsert = (query: unknown): 'kept row inserted' | 'kept audit row inserted' | undefined => {
  if (typeof query !== 'object' || query === null || !('sql' in query) || !('args' in query)) {
    return undefined;
  }
  const { sql, args } = query;
  if (typeof sql !== 'string' || !sql.startsWith('INSERT') || !Array.isArray(args)) {
    return undefined;
  }
  if (!args.some((arg) => typeof arg === 'string' && arg.includes('kept@example.com'))) {
    return undefined;
  }
  if (sql.includes('"users"')) {
    return 'kept row inserted';
  }
  return sql.includes('"audit_logs"') ? 'kept audit row inserted' : undefined;
};

describe('audit rows follow the commit of the writes they record', () => {
  let basePrisma: PrismaClient;

  beforeEach(async () => {
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  const auditedClient = (mode: WriteMode, base: PrismaClient = basePrisma) => {
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(base, {
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
    ...(nestedTransactions
      ? [
          {
            undoing: 'a nested transaction that rolls back',
            run: (tx: TransactionClient) =>
              tx
                .$transaction(async (nested) => {
                  await nested.user.create({ data: userData('undone@example.com') });
                  throw new Error('the nested callback failed');
                })
                .catch(() => undefined),
          },
        ]
      : []),
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

    describe.runIf(nestedTransactions)('with a nested transaction', () => {
      it('leaves an audit row for exactly the committed writes when a write starts while a nested transaction that rolls back is opening', async () => {
        // The SAVEPOINT is held until the write has reached the audit: a write that ran its
        // statements then would insert its row ahead of the savepoint and its audit row inside it,
        // which the nested rollback undoes
        const events: string[] = [];
        const savepoint = createHold('the nested SAVEPOINT');
        const writeReachedAudit = createHold('the audit of the write');
        const watchedPrisma = createClientOnWatchedConnection({
          beforeSavepoint: async () => {
            events.push('SAVEPOINT requested');
            await savepoint.hold();
          },
          afterSavepoint: () => events.push('SAVEPOINT run'),
          afterStatement: (query) => {
            const inserted = keptWriteInsert(query);
            if (inserted !== undefined) {
              events.push(inserted);
            }
          },
        });
        try {
          const provider = createAsyncLocalStorageProvider();
          let onContextRead = () => {};
          // The audit reads the context of an operation before it runs it
          const watchedProvider: AuditContextProvider = {
            ...provider,
            getContext: () => {
              onContextRead();
              return provider.getContext();
            },
          };
          const prisma = createAuditClient(watchedPrisma, {
            ...testAuditOptions(watchedProvider, { Prisma, schema: auditSchema }),
            write: { mode },
          });

          await watchedProvider.runAsync(testActor, () =>
            prisma.$transaction(
              async (tx) => {
                const nested = tx
                  .$transaction(async (nested) => {
                    await nested.user.create({ data: userData('undone@example.com') });
                    throw new Error('the nested callback failed');
                  })
                  .catch(() => undefined);
                try {
                  await savepoint.reached;
                  // Nothing else runs while the SAVEPOINT is held: the next context read is the write's
                  onContextRead = () => {
                    onContextRead = () => {};
                    writeReachedAudit.release();
                    void writeReachedAudit.hold();
                  };
                  const kept = tx.user.create({ data: userData('kept@example.com') }).then(() => undefined);
                  await writeReachedAudit.reached;
                  events.push('kept write reached the audit');
                  await afterPendingMicrotasks();
                  savepoint.release();
                  await Promise.all([nested, kept]);
                } finally {
                  savepoint.release();
                }
              },
              { timeout: 10_000 },
            ),
          );
          await flushAllPendingWrites();

          expect(events).toEqual([
            'SAVEPOINT requested',
            'kept write reached the audit',
            'SAVEPOINT run',
            'kept row inserted',
            'kept audit row inserted',
          ]);
          expect(await committedEmails()).not.toContain('undone@example.com');
          expect(await auditedEmails()).toEqual(await committedEmails());
        } finally {
          await watchedPrisma.$disconnect();
        }
      });

      it('leaves an audit row for exactly the committed writes when a write runs alongside a nested transaction that rolls back', async () => {
        // The write is held after its row's insert, before its audit row's, while the nested
        // transaction starts: a SAVEPOINT run then would put the audit row inside the savepoint,
        // which the nested rollback undoes, and leave the row outside it
        const events: string[] = [];
        const keptRowInserted = createHold('the insert of the row of the write');
        const watchedPrisma = createClientOnWatchedConnection({
          beforeSavepoint: async () => {
            events.push('SAVEPOINT requested');
          },
          afterSavepoint: () => events.push('SAVEPOINT run'),
          afterStatement: async (query) => {
            const inserted = keptWriteInsert(query);
            if (inserted !== undefined) {
              events.push(inserted);
            }
            if (inserted === 'kept row inserted') {
              await keptRowInserted.hold();
            }
          },
        });
        try {
          const { prisma, provider } = auditedClient(mode, watchedPrisma);

          await provider.runAsync(testActor, () =>
            prisma.$transaction(
              async (tx) => {
                const kept = tx.user.create({ data: userData('kept@example.com') }).then(() => undefined);
                try {
                  await keptRowInserted.reached;
                  const nested = tx
                    .$transaction(async (nested) => {
                      await nested.user.create({ data: userData('undone@example.com') });
                      throw new Error('the nested callback failed');
                    })
                    .catch(() => undefined);
                  events.push('nested transaction started');
                  await afterPendingMicrotasks();
                  keptRowInserted.release();
                  await Promise.all([kept, nested]);
                } finally {
                  keptRowInserted.release();
                }
              },
              { timeout: 10_000 },
            ),
          );
          await flushAllPendingWrites();

          expect(events).toEqual([
            'kept row inserted',
            'nested transaction started',
            'kept audit row inserted',
            'SAVEPOINT requested',
            'SAVEPOINT run',
          ]);
          expect(await committedEmails()).not.toContain('undone@example.com');
          expect(await auditedEmails()).toEqual(await committedEmails());
        } finally {
          await watchedPrisma.$disconnect();
        }
      });
    });
  });
});
