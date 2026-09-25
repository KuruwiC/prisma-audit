/**
 * Transaction Proxy Module
 *
 * Wraps the client's `$transaction` so that an interactive transaction runs its callback inside
 * the runtime scope of its transactional client: the audit reads and writes of the operations
 * in the callback share the client, and the writes that must wait for the commit queue on the
 * scope. The queue is drained strictly after `$transaction` resolves; on rejection it is
 * discarded unrun. The sequential form, `$transaction([...])`, passes through untouched: a list
 * of operations carries no callback, hence no interactive scope to establish.
 *
 * @module lifecycle/transaction-proxy
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import type { TransactionalPrismaClient } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import { enterTransaction } from '../runtime/scope.js';

type OriginalTransactionMethod = (...args: unknown[]) => Promise<unknown>;

/** Transaction proxy handler dependencies */
type TransactionProxyDependencies = {
  provider: AuditContextProvider;
  originalTransaction: OriginalTransactionMethod;
  target: object;
};

/**
 * Creates a wrapped transaction callback that runs the user's callback inside the runtime scope
 * of the transactional client.
 *
 * The transactional client and the deferred-write queue live in the runtime store (separate
 * from the app-owned audit context), so re-attributing the actor mid-transaction via
 * `runAsync` / `withActor` never drops them.
 *
 * The caller owns `deferredWrites` and is responsible for draining it AFTER the transaction
 * commits, so audit logs never persist for a transaction whose commit subsequently fails. The
 * callback clears the array at the start of each invocation (defensive against callback
 * re-invocation) and never drains itself.
 *
 * @param callback - User's transaction callback
 * @param context - Current audit context (app-owned: actor + request metadata)
 * @param provider - Audit context provider
 * @param deferredWrites - Caller-owned queue; the wrapped callback clears and fills it, the caller drains it post-commit
 * @returns Wrapped callback handling transaction context
 */
export const createWrappedTransactionCallback = (
  callback: (tx: TransactionalPrismaClient) => Promise<unknown>,
  context: AuditContext,
  provider: AuditContextProvider,
  deferredWrites: Array<() => Promise<void>>,
): ((txClient: TransactionalPrismaClient) => Promise<unknown>) => {
  return async (txClient: TransactionalPrismaClient): Promise<unknown> => {
    // Defensive against callback re-invocation: start each run with an empty queue.
    deferredWrites.length = 0;

    return enterTransaction(provider, context, { client: txClient, deferredWrites }, () => callback(txClient));
  };
};

/**
 * Creates a transaction proxy handler that intercepts $transaction calls
 *
 * Interactive transactions (callback form) run inside the runtime scope of their transactional
 * client. Sequential transactions (array form) pass through unchanged: a list of operations
 * carries no interactive scope.
 *
 * Deferred writes are drained strictly AFTER `$transaction` resolves (i.e. after commit), so an
 * audit log never persists for a transaction whose commit subsequently fails. On rejection the
 * locally-owned queue is discarded with the thrown error (no drain). This matches the
 * implicit transaction `openImplicitTransaction` opens.
 *
 * @param deps - Dependencies for transaction proxy
 * @returns Async function handling $transaction calls
 */
export const createTransactionProxyHandler = (
  deps: TransactionProxyDependencies,
): ((...args: unknown[]) => Promise<unknown>) => {
  const { provider, originalTransaction, target } = deps;

  return async (...args: unknown[]): Promise<unknown> => {
    const context = provider.getContext();

    if (!context) {
      return originalTransaction.apply(target, args);
    }

    if (typeof args[0] === 'function') {
      const callback = args[0] as (tx: TransactionalPrismaClient) => Promise<unknown>;
      const options = args[1] as Record<string, unknown> | undefined;

      const deferredWrites: Array<() => Promise<void>> = [];
      const wrappedCallback = createWrappedTransactionCallback(callback, context, provider, deferredWrites);

      const transactionArgs = options ? [wrappedCallback, options] : [wrappedCallback];
      // Drain only after $transaction resolves (after commit). On rejection the error
      // propagates and the locally-owned queue is discarded unrun.
      const result = await originalTransaction.apply(target, transactionArgs);

      for (const deferredWrite of deferredWrites) {
        trackPendingWrite(deferredWrite);
      }

      return result;
    }

    return originalTransaction.apply(target, args);
  };
};

/**
 * Creates a Proxy over the extended client that traps `$transaction` only.
 *
 * Every other property is returned as the client holds it, so method identity
 * (`client.user.findMany === client.user.findMany`), `in` checks and the prototype chain are
 * those of the client itself.
 *
 * @param extendedClient - Prisma client with audit extension
 * @param provider - Audit context provider
 * @returns Proxied client with transaction interception
 */
export const createTransactionProxy = <TClient extends object>(
  extendedClient: TClient,
  provider: AuditContextProvider,
): TClient => {
  return new Proxy(extendedClient, {
    get(target, prop) {
      if (prop === '$transaction') {
        const originalTransaction = Reflect.get(target, prop) as OriginalTransactionMethod;
        return createTransactionProxyHandler({ provider, originalTransaction, target });
      }
      return Reflect.get(target, prop);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    getPrototypeOf(target) {
      return Reflect.getPrototypeOf(target);
    },
  });
};
