/**
 * Interactive Transaction Tests
 *
 * `createOpenTransaction` opens the interactive transaction every audited operation can run in.
 * The specs drive it against a fake client whose `$transaction` runs the callback the way Prisma
 * does (once, again when it retries, with the commit settling after the callback) and check what
 * the body receives, the audit context it runs under, how the transaction ends, when the writes
 * the audit queued until the commit start, and how the outcomes of its operations are settled.
 */

import { type AuditContext, AuditRollbackError, createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import { createOpenTransaction } from '../../src/runtime/interactive-transaction.js';
import { flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
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

/** The outcome of an operation named `name`, which logs how it is settled */
const loggedOutcome = (events: string[], name: string) => ({
  settle: async (fate: 'committed' | 'not-committed') => {
    events.push(`${name} ${fate === 'committed' ? 'committed' : 'not committed'}`);
  },
});

describe('createOpenTransaction', () => {
  it("runs the body with a transaction whose client is Prisma's transaction client and whose queues are empty", async () => {
    const provider = createAsyncLocalStorageProvider();
    const { client, $transaction } = clientWith(txClient);
    let seen: ActiveTransaction | undefined;

    await createOpenTransaction(provider)(client, [], async (transaction) => {
      seen = transaction;
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.instances[0]).toBe(client);
    expect(seen?.client).toBe(txClient);
    expect(seen?.audit.queued).toEqual([]);
    expect(seen?.audit.failures).toEqual([]);
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

  describe('writes queued until the commit', () => {
    /** The writes the body queues, each logging `started <name>` once it is started */
    const queueingBody = (events: string[], ...names: string[]) => {
      return async (transaction: ActiveTransaction) => {
        for (const name of names) {
          transaction.audit.afterCommit(async () => {
            events.push(`started ${name}`);
          });
        }
        return 'result';
      };
    };

    it('starts them as pending writes once $transaction has resolved, not while it settles the commit', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient, async (callback) => {
        const result = await callback(txClient);
        events.push('callback resolved');
        return result;
      });
      let finishWrite: () => void = () => {};
      const open = createOpenTransaction(createAsyncLocalStorageProvider());

      const result = await open(client, [], async (transaction) => {
        transaction.audit.afterCommit(
          () =>
            new Promise<void>((resolve) => {
              events.push('started');
              finishWrite = resolve;
            }),
        );
        return 'committed';
      });
      const pendingAfterCommit = getPendingWriteCount();
      finishWrite();
      await flushAllPendingWrites();

      expect(result).toBe('committed');
      expect(events).toEqual(['callback resolved', 'started']);
      expect(pendingAfterCommit).toBe(1);
      expect(getPendingWriteCount()).toBe(0);
    });

    it('starts them in the order they were queued', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);

      await createOpenTransaction(createAsyncLocalStorageProvider())(
        client,
        [],
        queueingBody(events, 'first', 'second'),
      );
      await flushAllPendingWrites();

      expect(events).toEqual(['started first', 'started second']);
    });

    it('discards them unrun when the body rejects', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);
      const queue = queueingBody(events, 'first');

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          await queue(transaction);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      await flushAllPendingWrites();

      expect(events).toEqual([]);
    });

    it('discards them unrun when the transaction is rolled back for an audit failure', async () => {
      const events: string[] = [];
      const { client } = clientWith(txClient);
      const queue = queueingBody(events, 'first');

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
          await queue(transaction);
          transaction.audit.poison(new Error('audit failure'));
        }),
      ).rejects.toBeInstanceOf(AuditRollbackError);
      await flushAllPendingWrites();

      expect(events).toEqual([]);
    });

    it('discards them unrun when $transaction rejects after the callback resolved (commit failure)', async () => {
      const events: string[] = [];
      const commitError = new Error('commit failed');
      const { client } = clientWith(txClient, async (callback) => {
        await callback(txClient);
        throw commitError;
      });

      await expect(
        createOpenTransaction(createAsyncLocalStorageProvider())(client, [], queueingBody(events, 'first')),
      ).rejects.toBe(commitError);
      await flushAllPendingWrites();

      expect(events).toEqual([]);
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

    it('settles them in order as committed once $transaction has resolved, after the queued writes started, before returning', async () => {
      const events: string[] = [];
      let commitSettled = false;
      const { client } = clientWith(txClient, async (callback) => {
        const result = await callback(txClient);
        events.push('committed');
        commitSettled = true;
        return result;
      });

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        transaction.audit.afterCommit(async () => {
          events.push('queued write started');
        });
        await settlingBody(events, 'first')(transaction);
        await settlingBody(events, 'second')(transaction);
        expect(events).toEqual([]);
      });

      expect(commitSettled).toBe(true);
      expect(events).toEqual(['committed', 'queued write started', 'first committed', 'second committed']);
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

  describe('when Prisma runs the callback again', () => {
    it('empties the queues first, so that only what the last run queued is started, the transaction is not rolled back for an earlier run and the outcomes of an earlier run are settled as not committed', async () => {
      const events: string[] = [];
      const { client, $transaction } = clientWith(txClient, async (callback) => {
        await callback(txClient).catch(() => undefined);
        return callback(txClient);
      });
      const seenOnEntry: Array<{ readonly deferredWrites: number; readonly auditFailures: number }> = [];
      let run = 0;

      await createOpenTransaction(createAsyncLocalStorageProvider())(client, [], async (transaction) => {
        run += 1;
        seenOnEntry.push({
          deferredWrites: transaction.audit.queued.length,
          auditFailures: transaction.audit.failures.length,
        });
        const name = `run ${run}`;
        await transaction.audit.outcomes.add(loggedOutcome(events, `settled ${name}`), true);
        transaction.audit.afterCommit(async () => {
          events.push(`started ${name}`);
        });
        if (run === 1) {
          transaction.audit.poison(new Error('audit failure of the first run'));
        }
      });
      await flushAllPendingWrites();

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(seenOnEntry).toEqual([
        { deferredWrites: 0, auditFailures: 0 },
        { deferredWrites: 0, auditFailures: 0 },
      ]);
      expect(events).toEqual(['settled run 1 not committed', 'started run 2', 'settled run 2 committed']);
    });
  });
});
