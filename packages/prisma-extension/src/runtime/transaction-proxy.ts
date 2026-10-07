/**
 * Transaction Proxy Module
 *
 * Wraps the client's `$transaction` so that an interactive transaction runs its callback inside
 * the runtime scope of its transactional client, whether or not an audit context is set when
 * `$transaction` is called: the audit reads and writes of the operations in the callback share
 * the client, and the writes that must wait for the commit queue on the scope. The queue is
 * drained strictly after `$transaction` resolves; on rejection it is discarded unrun. The proxy
 * also wraps every client derived from the client by `$extends`.
 *
 * With `openImplicitTransaction`, the proxy also wraps the client's model delegates and raw-query
 * methods (`operation-recipe.ts`): a write whose audit is awaited runs in an interactive
 * transaction of the client it was called on, and a batch `$transaction([...])` of the client's
 * operations runs as one interactive transaction when one of them is an audited write whose audit
 * is awaited, as Prisma's own batch otherwise. Without it, the sequential form passes through
 * untouched.
 *
 * @module runtime/transaction-proxy
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { createRecipeClient, type RecipeConfig, takeBatchRecipes } from './operation-recipe.js';
import { drainAfterCommit, enterTransaction, withScope } from './scope.js';

type TransactionMethod = (...args: unknown[]) => Promise<unknown>;

export interface TransactionProxyConfig {
  readonly provider: AuditContextProvider;
  /** Present with `openImplicitTransaction`: how the client's operations open their transaction */
  readonly recipeConfig?: RecipeConfig;
}

type TransactionProxyDependencies = TransactionProxyConfig & {
  originalTransaction: TransactionMethod;
  target: object;
  /** The proxy `$transaction` was read from */
  receiver: object;
};

/** The one option of a batch `$transaction([...])`, which an interactive transaction takes as well */
const isolationLevelOptionOf = (options: unknown): Array<{ readonly isolationLevel: unknown }> => {
  const isolationLevel: unknown =
    typeof options === 'object' && options !== null ? Reflect.get(options, 'isolationLevel') : undefined;
  return isolationLevel === undefined ? [] : [{ isolationLevel }];
};

/**
 * Creates a wrapped transaction callback that runs the user's callback inside the runtime scope
 * of the transactional client.
 *
 * The transactional client and the deferred-write queue live in the runtime store (separate
 * from the app-owned audit context), so re-attributing the actor mid-transaction via
 * `runAsync` / `withActor` never drops them.
 *
 * The caller owns `deferredWrites` and drains it once the transaction has committed, so audit
 * logs never persist for a transaction whose commit fails. The callback empties the queue each
 * time it runs.
 */
export const createWrappedTransactionCallback = (
  callback: (tx: PrismaHandle) => Promise<unknown>,
  context: AuditContext | undefined,
  provider: AuditContextProvider,
  deferredWrites: Array<() => Promise<void>>,
): ((txClient: PrismaHandle) => Promise<unknown>) => {
  return async (txClient: PrismaHandle): Promise<unknown> => {
    deferredWrites.length = 0;

    return enterTransaction(provider, context, { client: txClient, deferredWrites }, () => callback(txClient));
  };
};

/**
 * Creates a transaction proxy handler that intercepts $transaction calls
 *
 * Deferred writes are drained once `$transaction` has resolved, after commit, so an audit log
 * never persists for a transaction whose commit fails; on rejection the queue is discarded.
 */
export const createTransactionProxyHandler = (
  deps: TransactionProxyDependencies,
): ((...args: unknown[]) => Promise<unknown>) => {
  const { provider, recipeConfig, originalTransaction, target, receiver } = deps;

  const runInteractive = async (
    callback: (tx: PrismaHandle) => Promise<unknown>,
    options: unknown[],
  ): Promise<unknown> => {
    const deferredWrites: Array<() => Promise<void>> = [];
    const wrappedCallback = createWrappedTransactionCallback(callback, provider.getContext(), provider, deferredWrites);
    const result = await originalTransaction.apply(target, [wrappedCallback, ...options]);
    drainAfterCommit(deferredWrites);
    return result;
  };

  /** Prisma's own batch, its operations marked as parts of it while Prisma triggers them */
  const runPrismaBatch = (batchArgs: unknown[]): Promise<unknown> =>
    withScope({ isInPrismaBatch: true }, () => originalTransaction.apply(target, batchArgs));

  /** In the interactive transaction, the recipes run one after another in list order, as Prisma runs a batch */
  const runRecipeBatch = async (
    items: readonly unknown[],
    options: unknown,
    config: RecipeConfig,
  ): Promise<unknown> => {
    const { awaitsAudit, operationsOn } = takeBatchRecipes(items, receiver, config);
    if (!awaitsAudit) {
      return runPrismaBatch(options === undefined ? [operationsOn(target)] : [operationsOn(target), options]);
    }
    return runInteractive(async (tx) => {
      const results: unknown[] = [];
      for (const operation of operationsOn(tx)) {
        results.push(await operation);
      }
      return results;
    }, isolationLevelOptionOf(options));
  };

  return async (...args: unknown[]): Promise<unknown> => {
    const [first, options] = args;
    if (typeof first !== 'function') {
      return recipeConfig && Array.isArray(first) && first.length > 0
        ? runRecipeBatch(first, options, recipeConfig)
        : runPrismaBatch(args);
    }
    const callback = first as (tx: PrismaHandle) => Promise<unknown>;
    return runInteractive(callback, options ? [options] : []);
  };
};

/**
 * Creates a Proxy over the extended client that traps `$transaction`, and `$extends` so that a
 * client derived from it is proxied the same way.
 *
 * Every other property is returned as the client holds it, so method identity
 * (`client.user.findMany === client.user.findMany`), `in` checks and the prototype chain are
 * those of the client itself.
 */
export const createTransactionProxy = <TClient extends object>(
  extendedClient: TClient,
  config: TransactionProxyConfig,
): TClient => {
  const recipeClient = config.recipeConfig && createRecipeClient(config.recipeConfig);
  return new Proxy(extendedClient, {
    get(target, prop, receiver: object) {
      if (prop === '$transaction') {
        const originalTransaction = Reflect.get(target, prop) as TransactionMethod;
        return createTransactionProxyHandler({ ...config, originalTransaction, target, receiver });
      }
      if (prop === '$extends') {
        const originalExtends = Reflect.get(target, prop) as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          const derived = originalExtends.apply(target, args);
          return typeof derived === 'object' && derived !== null ? createTransactionProxy(derived, config) : derived;
        };
      }
      const wrapped = recipeClient?.propertyOf(receiver, target, prop);
      return wrapped ? wrapped.value : Reflect.get(target, prop);
    },
  });
};
