/**
 * Interactive transactions the audited client wraps
 *
 * Every interactive transaction an audited operation can run in goes through here: the one the
 * caller opens with `$transaction(callback)`, the one a batch `$transaction([...])` holding a write
 * runs as, and the one the client opens around an atomic write issued outside any. The body
 * receives the transaction as an `ActiveTransaction`, which the operations bound to it carry to the
 * audit. Each run of the body has a core `TransactionAudit` of its own; every audit row of the
 * transaction's operations is written in the transaction, whatever the write mode, so it commits
 * and rolls back with the rows it records. The transaction and each transaction nested in it,
 * which the database runs as a savepoint, are levels of one connection: the innermost open level
 * holds what every operation on that connection records, and a nested level's audit is merged into
 * the level it was opened in when it ends. Each level keeps the audited operations running on it:
 * a transaction nested in it opens only once they have settled, an operation that starts while one
 * is opening runs on it once it has opened, and once the body has resolved or rejected, the level
 * waits for those it did not await before it checks that it can commit. From then on the level is
 * closing: an operation that starts on it runs once it has ended, on the level open then.
 * When an audit failure failed an operation of the transaction and the body resolved all the same,
 * the transaction is rolled back with core's `AuditRollbackError`. When an operation of the
 * transaction failed and the body resolved all the same, a query checks that the database did not
 * abort the transaction on that failure (PostgreSQL does, and answers the commit with a rollback);
 * when it did, the body rejects with the database's error, so `$transaction` rejects with it and
 * the transaction is rolled back. The outcomes of the transaction's operations are settled once
 * `$transaction` has resolved, as committed, or rejected, as not committed; an operation bound to
 * no transaction settles its own (core's `settledIn`).
 *
 * @module runtime/interactive-transaction
 */

import {
  type AuditContext,
  type AuditContextProvider,
  createTransactionAudit,
  type TransactionAudit,
} from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { invokeMethod } from '../utils/invoke-method.js';
import { type ActiveTransaction, currentOperations, withScope } from './scope.js';

/**
 * Runs `body` in an interactive transaction of `client`, opened with `options`: nested in `parent`
 * when `client` is a client of `parent`, as a savepoint of `parent`'s transaction, whose isolation
 * level it keeps. `bind` makes the transaction's `boundClient`.
 */
export type OpenTransaction = (
  client: object,
  options: readonly unknown[],
  bind: (transaction: ActiveTransaction) => PrismaHandle,
  body: (transaction: ActiveTransaction) => Promise<unknown>,
  parent?: ActiveTransaction,
) => Promise<unknown>;

type ContextRunner = Pick<AuditContextProvider, 'getContext' | 'runAsync'>;

/**
 * Runs `fn` with `auditContext` re-established, when there is one: a `$transaction` callback may
 * start on a different microtask than its caller, and the audit context must be present when it
 * does
 */
const withAuditContext = <T>(
  provider: ContextRunner,
  auditContext: AuditContext | undefined,
  fn: () => Promise<T>,
): Promise<T> => (auditContext ? provider.runAsync(auditContext, fn) : fn());

const declaredIsolationLevelOf = (options: readonly unknown[]): string | undefined => {
  const [first] = options;
  const level: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'isolationLevel') : undefined;
  return typeof level === 'string' ? level : undefined;
};

/**
 * Fails with the database's error when the database aborted the transaction of `txClient` on an
 * earlier failed statement; succeeds on a database that keeps a transaction usable after one, and
 * after a rollback to a savepoint
 */
const assertTransactionUsable = async (txClient: PrismaHandle): Promise<void> => {
  await invokeMethod(txClient, '$queryRawUnsafe', ['SELECT 1']);
};

interface TransactionLevel {
  readonly audit: TransactionAudit;
  readonly operations: Set<Promise<void>>;
  /** The nested transactions being opened, each settling once its SAVEPOINT has run or opening it failed */
  readonly openings: Set<Promise<void>>;
  /**
   * `closing` once its body and then its operations have settled; `ended` (resolving `ended`) once
   * its transaction or savepoint has settled, or Prisma runs the callback again
   */
  state: 'open' | 'closing' | 'ended';
  readonly ended: Promise<void>;
  readonly markEnded: () => void;
  statementFailed: boolean;
}

/** `Promise.withResolvers`, which Node 20 lacks */
const promiseWithResolve = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const createLevel = (): TransactionLevel => {
  const { promise: ended, resolve: markEnded } = promiseWithResolve();
  return {
    audit: createTransactionAudit(),
    operations: new Set(),
    openings: new Set(),
    state: 'open',
    ended,
    markEnded,
    statementFailed: false,
  };
};

const markOpening = (level: TransactionLevel): (() => void) => {
  const { promise: opening, resolve: settle } = promiseWithResolve();
  level.openings.add(opening);
  return () => {
    level.openings.delete(opening);
    settle();
  };
};

/**
 * Waits for the audited operations on `level`, those that start meanwhile included, except `own`,
 * the operations the wait runs inside, which wait for it
 */
const operationsSettled = async (level: TransactionLevel, own: readonly Promise<void>[]): Promise<void> => {
  for (;;) {
    const waited = [...level.operations].filter((operation) => !own.includes(operation));
    if (waited.length === 0) {
      return;
    }
    await Promise.allSettled(waited);
  }
};

/** The levels open on the connection of each transaction this module opened, outermost first */
const levelsOf = new WeakMap<ActiveTransaction, TransactionLevel[]>();

/**
 * The transaction of `client`, opened as `own`, on the connection whose open levels are `levels`.
 * Every statement runs in the innermost level open when it runs, whichever client of the
 * connection issued it, so the audit and failed statements are that level's, or once every level
 * has ended, `own`'s, which an operation settling late settles on. An operation waits out a nested
 * transaction being opened so that none of its statements runs before the SAVEPOINT and another
 * after it, unless it starts inside one running on the level, which the opening waits for. On a
 * level that has ended it starts at once, and Prisma rejects its statements.
 */
const transactionOn = (
  client: PrismaHandle,
  isolationLevel: string | undefined,
  own: TransactionLevel,
  levels: TransactionLevel[],
  bind: (transaction: ActiveTransaction) => PrismaHandle,
): ActiveTransaction => {
  const innermost = () => levels.at(-1) ?? own;
  let boundClient: PrismaHandle | undefined;
  const transaction: ActiveTransaction = {
    client,
    get boundClient() {
      boundClient ??= bind(transaction);
      return boundClient;
    },
    isolationLevel,
    get audit() {
      return innermost().audit;
    },
    runOperation: async (run) => {
      const flow = currentOperations();
      let level = innermost();
      for (;;) {
        if (level.state === 'closing') {
          await level.ended;
        } else if (level.openings.size > 0 && !flow.some((operation) => level.operations.has(operation))) {
          await Promise.allSettled([...level.openings]);
        } else {
          break;
        }
        level = innermost();
      }
      const { promise: operation, resolve: settle } = promiseWithResolve();
      level.operations.add(operation);
      try {
        return await withScope({ operations: [...flow, operation] }, () => run(level.audit));
      } finally {
        level.operations.delete(operation);
        settle();
      }
    },
    noteStatementFailed: () => {
      innermost().statementFailed = true;
    },
  };
  levelsOf.set(transaction, levels);
  return transaction;
};

/**
 * The `OpenTransaction` of the clients whose audit context `provider` holds. The audit context set
 * when the transaction is opened is the one its body runs with. Each time Prisma runs the
 * callback, the level of an earlier run, which Prisma rolled back, ends as rolled back and a new
 * one begins. The audit of the last run ends once `$transaction` has settled, after the commit or
 * the release of the savepoint: a nested transaction's is merged into the level it was opened in
 * (core's `mergeInto`); an outermost transaction's outcomes are settled (core's `end`), and
 * `$transaction` returns or rejects once each has been reported.
 */
export const createOpenTransaction =
  (provider: ContextRunner): OpenTransaction =>
  async (client, options, bind, body, parent) => {
    const auditContext = provider.getContext();
    const own = currentOperations();
    const levels = parent === undefined ? [] : levelsOf.get(parent);
    if (levels === undefined) {
      throw new Error('[@prisma-audit] A nested transaction was opened in a transaction the audit did not open');
    }
    const isolationLevel = parent === undefined ? declaredIsolationLevelOf(options) : parent.isolationLevel;
    const enclosing = levels.at(-1);
    const opened = enclosing === undefined ? () => {} : markOpening(enclosing);
    if (enclosing !== undefined) {
      await operationsSettled(enclosing, own);
    }
    let current: TransactionLevel | undefined;
    const end = async (committed: boolean): Promise<void> => {
      const level = current;
      if (level === undefined) {
        return;
      }
      current = undefined;
      levels.splice(levels.indexOf(level), 1);
      level.state = 'ended';
      level.markEnded();
      await (enclosing === undefined ? level.audit.end(committed) : level.audit.mergeInto(enclosing.audit, committed));
    };
    const callback = async (txClient: PrismaHandle) => {
      await end(false);
      const level = createLevel();
      current = level;
      levels.push(level);
      opened();
      const result = await withAuditContext(provider, auditContext, () =>
        body(transactionOn(txClient, isolationLevel, level, levels, bind)),
      ).finally(async () => {
        await operationsSettled(level, own);
        level.state = 'closing';
      });
      level.audit.assertCommittable();
      if (level.statementFailed) {
        await assertTransactionUsable(txClient);
      }
      return result;
    };
    let result: unknown;
    try {
      result = await invokeMethod(client, '$transaction', [callback, ...options]);
    } catch (error) {
      await end(false);
      throw error;
    } finally {
      opened();
    }
    await end(true);
    return result;
  };
