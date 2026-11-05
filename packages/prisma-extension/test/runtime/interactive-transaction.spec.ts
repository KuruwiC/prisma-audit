/**
 * Interactive Transaction Tests
 *
 * `createOpenTransaction` opens the interactive transaction every audited operation can run in.
 * The specs drive it against a fake client whose `$transaction` runs the callback the way Prisma
 * does (once, again when it retries, with the commit settling after the callback) and check what
 * the body receives, the audit context it runs under, how the transaction ends, how the outcomes
 * of its operations are settled, and how a level waits for the audited operations running on it.
 */

import { type AuditContext, AuditRollbackError, createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import { createOpenTransaction } from '../../src/runtime/interactive-transaction.js';
import type { ActiveTransaction } from '../../src/runtime/scope.js';

const context: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };
const otherContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-2' } };

type TransactionCallback = (tx: PrismaHandle) => Promise<unknown>;

/**
 * A client whose `$transaction` hands the callback `txClient` and resolves with its result, as the
 * client does once the transaction has committed; `run` replaces how the callback is run and the
 * commit settles.
 */
const clientWith = (
  txClient: PrismaHandle,
  run: (callback: TransactionCallback) => Promise<unknown> = (callback) => callback(txClient),
) => {
  const $transaction = vi.fn(async (callback: TransactionCallback, ..._options: unknown[]) => run(callback));
  return { client: { $transaction }, $transaction };
};

const txClient: PrismaHandle = { _isTx: true };

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Lets every continuation that can run now run: a macrotask runs once the microtask queue is empty */
const settleMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The error `run` throws, if any, kept to be asserted once the body Prisma may run again has returned */
const errorThrownBy = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** The outcome of an operation named `name`, which logs how it is settled */
const loggedOutcome = (events: string[], name: string) => ({
  settle: async (fate: 'committed' | 'not-committed') => {
    events.push(`${name} ${fate === 'committed' ? 'committed' : 'not committed'}`);
  },
});

describe('createOpenTransaction', () => {
  it("runs the body with a transaction whose client is Prisma's transaction client and whose audit holds no failure", async () => {
    const provider = createAsyncLocalStorageProvider();
    const { client, $transaction } = clientWith(txClient);
    let seen: ActiveTransaction | undefined;

    await createOpenTransaction(provider)(client, [], async (transaction) => {
      seen = transaction;
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.instances[0]).toBe(client);
    expect(seen?.client).toBe(txClient);
    expect(() => seen?.audit.assertCommittable()).not.toThrow();
  });

  it('fails when the client has no $transaction', async () => {
    const open = createOpenTransaction(createAsyncLocalStorageProvider());
    const body = vi.fn(async () => {});

    await expect(open({}, [], body)).rejects.toThrow('Client method "$transaction" not found');

    expect(body).not.toHaveBeenCalled();
  });

  describe('audit context', () => {
    it('runs the body under the audit context that was set when the transaction was opened', async () => {
      const provider = createAsyncLocalStorageProvider();
      // The callback starts under another audit context than the one the transaction was opened under
      const { client } = clientWith(txClient, (callback) => provider.runAsync(otherContext, () => callback(txClient)));
      let contextInsideBody: AuditContext | undefined;

      await provider.runAsync(context, () =>
        createOpenTransaction(provider)(client, [], async () => {
          contextInsideBody = provider.getContext();
        }),
      );

      expect(contextInsideBody).toEqual(context);
    });

    it('does not call runAsync when there was no audit context, and runs the body under the one the callback starts with', async () => {
      const provider = createAsyncLocalStorageProvider();
      const runAsync = vi.spyOn(provider, 'runAsync');
      const { client } = clientWith(txClient, (callback) => provider.runAsync(otherContext, () => callback(txClient)));
      let contextInsideBody: AuditContext | undefined;

      await createOpenTransaction(provider)(client, [], async () => {
        contextInsideBody = provider.getContext();
      });

      // The one call is the fake client's own, which starts the callback
      expect(runAsync).toHaveBeenCalledTimes(1);
      expect(contextInsideBody).toEqual(otherContext);
    });
  });

  it('forwards the options to $transaction after the callback, and none when it got none', async () => {
    const { client, $transaction } = clientWith(txClient);
    const open = createOpenTransaction(createAsyncLocalStorageProvider());
    const options = { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 };

    await open(client, [options], async () => {});
    await open(client, [], async () => {});

    expect($transaction.mock.calls[0]).toHaveLength(2);
    expect($transaction.mock.calls[0]?.[1]).toBe(options);
    expect($transaction.mock.calls[1]).toHaveLength(1);
  });

  describe('outcome', () => {
    it('resolves with the result of the body', async () => {
      const { client } = clientWith(txClient);

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async () => 'committed'),
      ).resolves.toBe('committed');
    });

    it('rejects with the error of the body', async () => {
      const { client } = clientWith(txClient);
      const bodyError = new Error('the body failed');

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async () => {
          throw bodyError;
        }),
      ).rejects.toBe(bodyError);
    });

    it('rolls back with an AuditRollbackError whose cause is the first audit failure when the body resolves after some were recorded', async () => {
      const { client } = clientWith(txClient);
      const first = new Error('first audit failure');
      const second = new Error('second audit failure');

      const opened = createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        transaction.audit.poison(first);
        transaction.audit.poison(second);
        return 'resolved all the same';
      });

      await expect(opened).rejects.toBeInstanceOf(AuditRollbackError);
      await expect(opened).rejects.toHaveProperty('cause', first);
    });

    it('rejects with the error of the body, not an AuditRollbackError, when it throws after an audit failure was recorded', async () => {
      const { client } = clientWith(txClient);
      const bodyError = new Error('the body failed');

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          transaction.audit.poison(new Error('audit failure'));
          throw bodyError;
        }),
      ).rejects.toBe(bodyError);
    });
  });

  describe('a failed statement of the transaction', () => {
    const probedClient = (probe: () => Promise<unknown>) => {
      const $queryRawUnsafe = vi.fn(probe);
      return { txClient: { $queryRawUnsafe }, $queryRawUnsafe };
    };

    it('makes a body that resolved check with SELECT 1 that the transaction is still usable, and resolves when it is', async () => {
      const { txClient: probed, $queryRawUnsafe } = probedClient(async () => [{ '?column?': 1 }]);
      const { client } = clientWith(probed);

      const result = await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        transaction.noteStatementFailed();
        return 'caught';
      });

      expect(result).toBe('caught');
      expect($queryRawUnsafe.mock.calls).toEqual([['SELECT 1']]);
    });

    it('rejects with the error of the check when the database aborted the transaction', async () => {
      const aborted = new Error('current transaction is aborted, commands ignored until end of transaction block');
      const { txClient: probed } = probedClient(async () => {
        throw aborted;
      });
      const { client } = clientWith(probed);

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          transaction.noteStatementFailed();
        }),
      ).rejects.toBe(aborted);
    });

    it('makes no check when no statement of the transaction failed', async () => {
      const { txClient: probed, $queryRawUnsafe } = probedClient(async () => []);
      const { client } = clientWith(probed);

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async () => 'resolved');

      expect($queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('makes no check for a failure noted in an earlier run of the callback', async () => {
      const { txClient: probed, $queryRawUnsafe } = probedClient(async () => []);
      const { client } = clientWith(probed, async (callback) => {
        await callback(probed).catch(() => undefined);
        return callback(probed);
      });
      let run = 0;

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        run += 1;
        if (run === 1) {
          transaction.noteStatementFailed();
          throw new Error('write conflict');
        }
      });

      expect($queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('the outcomes of its operations', () => {
    /** A body that adds the outcome of a succeeded operation to the transaction */
    const settlingBody =
      (events: string[], name: string, fails?: Error) =>
      async (transaction: ActiveTransaction): Promise<void> => {
        await transaction.audit.outcomes.add(loggedOutcome(events, name), true);
        if (fails) throw fails;
      };

    it('settles them in order as committed once $transaction has resolved, before returning', async () => {
      const events: string[] = [];
      let commitSettled = false;
      const { client } = clientWith(txClient, async (callback) => {
        const result = await callback(txClient);
        events.push('committed');
        commitSettled = true;
        return result;
      });

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        await settlingBody(events, 'first')(transaction);
        await settlingBody(events, 'second')(transaction);
        expect(events).toEqual([]);
      });

      expect(commitSettled).toBe(true);
      expect(events).toEqual(['committed', 'first committed', 'second committed']);
    });

    it('settles them as not committed when the body rejects, before rejecting', async () => {
      const events: string[] = [];
      const bodyError = new Error('callback failed');
      const { client } = clientWith(txClient);

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], settlingBody(events, 'first', bodyError)),
      ).rejects.toBe(bodyError);

      expect(events).toEqual(['first not committed']);
    });

    it('settles them as not committed when the transaction is rolled back for an audit failure', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          await settlingBody(events, 'first')(transaction);
          transaction.audit.poison(new Error('audit write failed'));
        }),
      ).rejects.toBeInstanceOf(AuditRollbackError);

      expect(events).toEqual(['first not committed']);
    });

    it('settles them as not committed when $transaction rejects after the callback resolved (commit failure)', async () => {
      const events: string[] = [];
      const commitError = new Error('commit failed');
      const { client } = clientWith(txClient, async (callback) => {
        await callback(txClient);
        throw commitError;
      });

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], settlingBody(events, 'first')),
      ).rejects.toBe(commitError);

      expect(events).toEqual(['first not committed']);
    });
  });

  describe('an operation that settles after its transaction has', () => {
    it('is settled at once as not committed when the transaction rolled back before it finished', async () => {
      const events: string[] = [];
      const bodyError = new Error('a sibling operation failed');
      const { client } = clientWith(txClient);
      let addLate: (() => Promise<void>) | undefined;

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          addLate = () => transaction.audit.outcomes.add(loggedOutcome(events, 'straggler'), true);
          throw bodyError;
        }),
      ).rejects.toBe(bodyError);
      await addLate?.();

      expect(events).toEqual(['straggler not committed']);
    });
  });

  describe('a transaction nested in another, which the database runs as a savepoint', () => {
    /** A transaction client whose `$transaction` opens the nested transaction on `nestedTx` */
    const nestingClient = (nestedTx: PrismaHandle) => ({ ...clientWith(nestedTx).client, _isTx: true });

    it('hands its outcomes, once it committed, to the transaction it is nested in, which settles them once it commits', async () => {
      const events: string[] = [];
      const nestedTx: PrismaHandle = { _isNestedTx: true };
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const { client } = clientWith(nestingClient(nestedTx));

      await open(client, [], async (outer) => {
        await open(
          outer.client,
          [],
          async (nested) => {
            expect(nested.client).toBe(nestedTx);
            await nested.audit.outcomes.add(loggedOutcome(events, 'nested operation'), true);
          },
          outer,
        );
        events.push('nested transaction resolved');
      });

      expect(events).toEqual(['nested transaction resolved', 'nested operation committed']);
    });

    it('settles its outcomes as not committed with the enclosing transaction when it rolls back', async () => {
      const events: string[] = [];
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const { client } = clientWith(nestingClient({ _isNestedTx: true }));
      const nestedError = new Error('the nested callback failed');

      await open(client, [], async (outer) => {
        await expect(
          open(
            outer.client,
            [],
            async (nested) => {
              await nested.audit.outcomes.add(loggedOutcome(events, 'nested operation'), true);
              throw nestedError;
            },
            outer,
          ),
        ).rejects.toBe(nestedError);
        expect(events).toEqual([]);
      });

      expect(events).toEqual(['nested operation not committed']);
    });

    it('records on the nested transaction what an operation of the enclosing one records while the nested one is open, since it runs inside the savepoint', async () => {
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const { client } = clientWith(nestingClient({ _isNestedTx: true }));

      const audits: Record<string, unknown> = {};

      await open(client, [], async (outer) => {
        audits.enclosingBefore = outer.audit;
        await open(
          outer.client,
          [],
          async (nested) => {
            audits.nested = nested.audit;
            audits.enclosingWhileNested = outer.audit;
            await outer.runOperation(async (audit) => {
              audits.operationWhileNested = audit;
            });
            throw new Error('the nested callback failed');
          },
          outer,
        ).catch(() => undefined);
        audits.enclosingAfter = outer.audit;
      });

      expect(audits.enclosingWhileNested).toBe(audits.nested);
      expect(audits.operationWhileNested).toBe(audits.nested);
      expect(audits.enclosingAfter).toBe(audits.enclosingBefore);
    });

    it('checks that the database did not abort the nested transaction on a statement that failed while it was open, and rolls it back alone when it did', async () => {
      const aborted = new Error('current transaction is aborted, commands ignored until end of transaction block');
      const nestedProbe = vi.fn(async () => {
        throw aborted;
      });
      const enclosingProbe = vi.fn(async () => []);
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const outerTx = { ...nestingClient({ $queryRawUnsafe: nestedProbe }), $queryRawUnsafe: enclosingProbe };
      const { client } = clientWith(outerTx);

      const result = await open(client, [], async (outer) => {
        await expect(
          open(
            outer.client,
            [],
            async () => {
              outer.noteStatementFailed();
            },
            outer,
          ),
        ).rejects.toBe(aborted);
        return 'committed';
      });

      expect(result).toBe('committed');
      expect(nestedProbe.mock.calls).toEqual([['SELECT 1']]);
      expect(enclosingProbe).not.toHaveBeenCalled();
    });
  });

  describe('the audited operations running on a level', () => {
    /** A transaction client whose `$transaction` opens the nested transaction on `nestedTx` */
    const nestingClient = (nestedTx: PrismaHandle) => {
      const nested = clientWith(nestedTx);
      return { txClient: { ...nested.client, _isTx: true }, nestedTransaction: nested.$transaction };
    };

    it('runs an operation with the audit of the innermost level open when it starts, which it keeps once that level has ended', async () => {
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const { txClient: outerTx } = nestingClient({ _isNestedTx: true });
      const { client } = clientWith(outerTx);
      const audits: Record<string, unknown> = {};

      await open(client, [], async (outer) => {
        audits.outer = outer.audit;
        await open(
          outer.client,
          [],
          async (nested) => {
            audits.nested = nested.audit;
            await nested.runOperation(async (audit) => {
              audits.captured = audit;
            });
          },
          outer,
        );
        await outer.runOperation(async (audit) => {
          audits.afterNested = audit;
        });
      });

      expect(audits.captured).toBe(audits.nested);
      expect(audits.afterNested).toBe(audits.outer);
    });

    it('opens a transaction nested in the level only once the operations running on it have settled', async () => {
      const events: string[] = [];
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const { txClient: outerTx, nestedTransaction } = nestingClient({ _isNestedTx: true });
      const { client } = clientWith(outerTx);
      const released = deferred();

      await open(client, [], async (outer) => {
        const running = outer.runOperation(async () => {
          await released.promise;
          events.push('operation settled');
        });
        const nested = open(
          outer.client,
          [],
          async () => {
            events.push('nested body ran');
          },
          outer,
        );
        await settleMicrotasks();
        expect(nestedTransaction).not.toHaveBeenCalled();
        released.resolve();
        await Promise.all([running, nested]);
      });

      expect(events).toEqual(['operation settled', 'nested body ran']);
    });

    it('opens a transaction nested in the level from inside an operation running on it without waiting for that operation, or one it runs in', async () => {
      const open = createOpenTransaction(createAsyncLocalStorageProvider());
      const { txClient: outerTx, nestedTransaction } = nestingClient({ _isNestedTx: true });
      const { client } = clientWith(outerTx);

      const result = await open(client, [], (outer) =>
        outer.runOperation(() =>
          outer.runOperation(() => open(outer.client, [], async () => 'nested committed', outer)),
        ),
      );

      expect(result).toBe('nested committed');
      expect(nestedTransaction).toHaveBeenCalledTimes(1);
    });

    it('waits, once the body has resolved, for the operations it did not await, so that an audit failure one of them records rolls the transaction back', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);
      const released = deferred();
      const auditFailure = new Error('the audit write failed');

      const opened = createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        void transaction
          .runOperation(async (audit) => {
            await released.promise;
            await audit.outcomes.add(loggedOutcome(events, 'unawaited operation'), true);
            audit.poison(auditFailure);
            throw auditFailure;
          })
          .catch(() => undefined);
        return 'resolved';
      });
      await settleMicrotasks();
      expect(events).toEqual([]);
      released.resolve();

      await expect(opened).rejects.toBeInstanceOf(AuditRollbackError);
      await expect(opened).rejects.toHaveProperty('cause', auditFailure);
      expect(events).toEqual(['unawaited operation not committed']);
    });

    it('waits, once the body has rejected, for the operations it did not await, and rejects with the error of the body', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);
      const released = deferred();
      const bodyError = new Error('the body failed');

      const opened = createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        void transaction
          .runOperation(async () => {
            await released.promise;
            events.push('operation settled');
            throw new Error('the operation failed');
          })
          .catch(() => undefined);
        throw bodyError;
      });
      const rejected = opened.catch((error: unknown) => {
        events.push('transaction rejected');
        return error;
      });
      await settleMicrotasks();
      expect(events).toEqual([]);
      released.resolve();

      expect(await rejected).toBe(bodyError);
      expect(events).toEqual(['operation settled', 'transaction rejected']);
    });

    it('waits for the operations that start while it waits', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        void transaction.runOperation(async () => {
          await settleMicrotasks();
          void transaction.runOperation(async () => {
            await settleMicrotasks();
            events.push('second operation settled');
          });
          events.push('first operation settled');
        });
      });

      expect(events).toEqual(['first operation settled', 'second operation settled']);
    });

    describe('while a transaction nested in the level is opening', () => {
      /**
       * A transaction client whose `$transaction` opens the nested transaction on `nestedTx`, or fails
       * with `fails`, once `savepoint` resolves, as Prisma calls the callback after SAVEPOINT has run
       */
      const gatedNestingClient = (nestedTx: PrismaHandle, fails?: Error) => {
        const savepoint = deferred();
        const nested = clientWith(nestedTx, async (callback) => {
          await savepoint.promise;
          if (fails) throw fails;
          return callback(nestedTx);
        });
        return { txClient: { ...nested.client, _isTx: true }, savepoint };
      };

      it('starts an operation once the nested transaction has opened, on the nested transaction', async () => {
        const events: string[] = [];
        const open = createOpenTransaction(createAsyncLocalStorageProvider());
        const { txClient: outerTx, savepoint } = gatedNestingClient({ _isNestedTx: true });
        const { client } = clientWith(outerTx);
        const audits: Record<string, unknown> = {};

        await open(client, [], async (outer) => {
          const nested = open(
            outer.client,
            [],
            async (opened) => {
              audits.nested = opened.audit;
              events.push('nested body ran');
            },
            outer,
          );
          await settleMicrotasks();
          const operation = outer.runOperation(async (audit) => {
            audits.captured = audit;
            events.push('operation ran');
          });
          await settleMicrotasks();
          expect(events).toEqual([]);
          savepoint.resolve();
          await Promise.all([nested, operation]);
        });

        expect(events).toEqual(['nested body ran', 'operation ran']);
        expect(audits.captured).toBe(audits.nested);
      });

      it('starts an operation on the level once the nested transaction failed to open', async () => {
        const open = createOpenTransaction(createAsyncLocalStorageProvider());
        const openError = new Error('SAVEPOINT failed');
        const { txClient: outerTx, savepoint } = gatedNestingClient({ _isNestedTx: true }, openError);
        const { client } = clientWith(outerTx);
        const audits: Record<string, unknown> = {};

        await open(client, [], async (outer) => {
          audits.outer = outer.audit;
          const nested = open(outer.client, [], async () => 'never runs', outer);
          await settleMicrotasks();
          const operation = outer.runOperation(async (audit) => {
            audits.captured = audit;
          });
          savepoint.resolve();
          await expect(nested).rejects.toBe(openError);
          await operation;
        });

        expect(audits.captured).toBe(audits.outer);
      });

      it('starts an operation inside one running on the level without waiting, since the nested transaction waits for that one', async () => {
        const open = createOpenTransaction(createAsyncLocalStorageProvider());
        const { txClient: outerTx, savepoint } = gatedNestingClient({ _isNestedTx: true });
        const { client } = clientWith(outerTx);
        const released = deferred();
        const audits: Record<string, unknown> = {};

        await open(client, [], async (outer) => {
          audits.outer = outer.audit;
          const running = outer.runOperation(async () => {
            await released.promise;
            await outer.runOperation(async (audit) => {
              audits.captured = audit;
            });
          });
          const nested = open(outer.client, [], async () => 'nested committed', outer);
          await settleMicrotasks();
          released.resolve();
          await running;
          savepoint.resolve();
          await nested;
        });

        expect(audits.captured).toBe(audits.outer);
      });
    });

    describe('while a level that has been checked is closing', () => {
      const aborted = new Error('current transaction is aborted, commands ignored until end of transaction block');

      /**
       * A transaction client whose `$transaction` runs the nested transaction's callback on
       * `nestedTx`, then releases or rolls back its savepoint once `release` resolves
       */
      const gatedReleaseClient = (nestedTx: PrismaHandle) => {
        const release = deferred();
        const nested = clientWith(nestedTx, async (callback) => {
          try {
            return await callback(nestedTx);
          } finally {
            await release.promise;
          }
        });
        return { txClient: { ...nested.client, _isTx: true }, release };
      };

      it.each([
        { body: 'resolves', run: async () => 'nested committed', nestedTx: {} },
        {
          body: 'rejects',
          run: async () => {
            throw new Error('the nested callback failed');
          },
          nestedTx: {},
        },
        {
          body: 'resolves after an audit failure',
          run: async (nested: ActiveTransaction) => {
            nested.audit.poison(new Error('nested audit failure'));
          },
          nestedTx: {},
        },
        {
          body: 'resolves on a transaction the database aborted',
          run: async (nested: ActiveTransaction) => {
            nested.noteStatementFailed();
          },
          nestedTx: {
            $queryRawUnsafe: async () => {
              throw aborted;
            },
          },
        },
      ])(
        'starts an operation once the nested transaction whose body $body has ended, on the enclosing transaction, whose audit its failure poisons',
        async ({ run, nestedTx }) => {
          const events: string[] = [];
          const open = createOpenTransaction(createAsyncLocalStorageProvider());
          const { txClient: outerTx, release } = gatedReleaseClient(nestedTx);
          const { client } = clientWith(outerTx);
          const operationFailure = new Error('the audit write of the operation failed');
          const audits: Record<string, unknown> = {};

          const opened = open(client, [], async (outer) => {
            audits.outer = outer.audit;
            const nested = open(outer.client, [], run, outer).catch(() => undefined);
            await settleMicrotasks();
            const operation = outer
              .runOperation(async (audit) => {
                audits.captured = audit;
                events.push('operation ran');
                audit.poison(operationFailure);
                throw operationFailure;
              })
              .catch(() => undefined);
            await settleMicrotasks();
            expect(events).toEqual([]);
            release.resolve();
            await Promise.all([nested, operation]);
            return 'resolved all the same';
          });

          await expect(opened).rejects.toBeInstanceOf(AuditRollbackError);
          await expect(opened).rejects.toHaveProperty('cause', operationFailure);
          expect(audits.captured).toBe(audits.outer);
        },
      );

      it('starts an operation issued on a run Prisma rolled back once Prisma runs the callback again, on the ended run, whose statements Prisma rejects', async () => {
        const events: string[] = [];
        const rolledBack = deferred();
        const retried = deferred();
        const { client } = clientWith(txClient, async (callback) => {
          await callback(txClient).catch(() => undefined);
          rolledBack.resolve();
          await retried.promise;
          return callback(txClient);
        });
        const runs: ActiveTransaction[] = [];

        const opened = createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          runs.push(transaction);
          if (runs.length === 1) {
            throw new Error('write conflict');
          }
          await settleMicrotasks();
        });
        await rolledBack.promise;
        const [first] = runs;
        const operation = first?.runOperation(async (audit) => {
          events.push('operation ran');
          return audit;
        });
        await settleMicrotasks();
        expect(events).toEqual([]);
        retried.resolve();
        await opened;

        await expect(operation).resolves.toBe(first?.audit);
        expect(events).toEqual(['operation ran']);
      });

      it('runs an operation on a transaction that has ended at once, on the ended transaction', async () => {
        const { client } = clientWith(txClient);
        let ended: ActiveTransaction | undefined;

        await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          ended = transaction;
        });

        await expect(ended?.runOperation(async (audit) => audit === ended?.audit)).resolves.toBe(true);
      });
    });
  });

  describe('when Prisma runs the callback again', () => {
    it('begins a new level, so that the transaction is not rolled back for an earlier run and the outcomes of an earlier run are settled as not committed', async () => {
      const events: string[] = [];
      const { client, $transaction } = clientWith(txClient, async (callback) => {
        await callback(txClient).catch(() => undefined);
        return callback(txClient);
      });
      const seenOnEntry: Array<{
        readonly audit: ActiveTransaction['audit'];
        readonly auditFailure: unknown;
      }> = [];
      let run = 0;

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        run += 1;
        seenOnEntry.push({
          audit: transaction.audit,
          auditFailure: errorThrownBy(() => transaction.audit.assertCommittable()),
        });
        const name = `run ${run}`;
        await transaction.audit.outcomes.add(loggedOutcome(events, `settled ${name}`), true);
        if (run === 1) {
          transaction.audit.poison(new Error('audit failure of the first run'));
        }
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      const [first, second] = seenOnEntry;
      expect(seenOnEntry).toHaveLength(2);
      expect(second?.audit).not.toBe(first?.audit);
      expect(seenOnEntry.map(({ auditFailure }) => auditFailure)).toEqual([undefined, undefined]);
      expect(events).toEqual(['settled run 1 not committed', 'settled run 2 committed']);
    });
  });
});
