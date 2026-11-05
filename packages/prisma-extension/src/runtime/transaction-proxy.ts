/**
 * Transaction Proxy Module
 *
 * Wraps the audited client so that every operation it issues is bound to the client it was
 * issued on (`operation-recipe.ts`): its model delegates and raw-query methods return recipes,
 * and `$transaction` hands an interactive callback a client whose operations are bound to that
 * callback's transaction. Every interactive transaction runs through `interactive-transaction.ts`,
 * which writes the audit rows of its operations in the transaction and rolls the transaction back
 * when an audit failure failed one of its operations. A batch `$transaction([...])` holding a model write
 * runs as one interactive transaction of the client, its operations one after another, so each
 * operation's audit reads and writes run between the batch's operations; a batch of reads and raw
 * queries only runs as Prisma's own batch. A `$transaction` on the client a callback receives
 * opens a transaction nested in the callback's, the batch form included. The proxy also wraps
 * every client derived from the client by `$extends`, and hands an extension function the proxy.
 *
 * @module runtime/transaction-proxy
 */

import type { AuditContextProvider } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { createOpenTransaction, type OpenTransaction } from './interactive-transaction.js';
import { createRecipeClient, type IssuingClient, type RecipeConfig, takeBatchRecipes } from './operation-recipe.js';

type TransactionMethod = (...args: unknown[]) => unknown;

export interface TransactionProxyConfig {
  readonly provider: AuditContextProvider;
  /** How the client's operations are made into recipes, and when they open their transaction */
  readonly recipeConfig: RecipeConfig;
}

type RecipeClient = ReturnType<typeof createRecipeClient>;

interface TransactionProxyDependencies {
  readonly recipeClient: RecipeClient;
  readonly openTransaction: OpenTransaction;
  readonly originalTransaction: TransactionMethod;
  /** The client `$transaction` was read from */
  readonly issuer: IssuingClient;
}

/** The one option of a batch `$transaction([...])`, which an interactive transaction takes as well */
const isolationLevelOptionOf = (options: unknown): Array<{ readonly isolationLevel: unknown }> => {
  const isolationLevel: unknown =
    typeof options === 'object' && options !== null ? Reflect.get(options, 'isolationLevel') : undefined;
  return isolationLevel === undefined ? [] : [{ isolationLevel }];
};

const createTransactionProxyHandler = (
  deps: TransactionProxyDependencies,
): ((...args: unknown[]) => Promise<unknown>) => {
  const { recipeClient, openTransaction, originalTransaction, issuer } = deps;
  const { receiver, target, transaction: parent } = issuer;

  const runBatch = async (items: readonly unknown[], options: unknown): Promise<unknown> => {
    const batch = takeBatchRecipes(items, receiver);
    if (parent === undefined && !batch.holdsModelWrite) {
      const operations = batch.operationsOn(target);
      return originalTransaction(...(options === undefined ? [operations] : [operations, options]));
    }
    return openTransaction(target, isolationLevelOptionOf(options), (transaction) => batch.runIn(transaction), parent);
  };

  return async (...args: unknown[]): Promise<unknown> => {
    const [first, options] = args;
    if (typeof first !== 'function') {
      return Array.isArray(first) ? runBatch(first, options) : originalTransaction(...args);
    }
    const callback = first as (tx: PrismaHandle) => Promise<unknown>;
    return openTransaction(
      target,
      options ? [options] : [],
      (transaction) => callback(recipeClient.boundClient(transaction)),
      parent,
    );
  };
};

/**
 * Creates a Proxy over the extended client that traps `$transaction`, the model delegates and
 * raw-query methods, and `$extends` so that a client derived from it is proxied the same way.
 *
 * Every other property is returned as the client holds it, so `in` checks and the prototype chain
 * are those of the client itself.
 */
export const createTransactionProxy = <TClient extends object>(
  extendedClient: TClient,
  config: TransactionProxyConfig,
): TClient => {
  const openTransaction = createOpenTransaction(config.provider);
  const recipeClient: RecipeClient = createRecipeClient(
    config.recipeConfig,
    openTransaction,
    (client) => proxy(client),
    (issuer, originalTransaction) =>
      createTransactionProxyHandler({ recipeClient, openTransaction, originalTransaction, issuer }),
  );
  const proxy = <T extends object>(client: T): T =>
    new Proxy(client, {
      get(target, prop, receiver: object) {
        if (prop === '$extends') {
          const originalExtends = Reflect.get(target, prop) as (...args: unknown[]) => unknown;
          return (...args: unknown[]): unknown => {
            const [extension] = args;
            if (typeof extension === 'function') {
              // Prisma calls an extension function with the client `$extends` is called on
              return Reflect.apply(extension, undefined, [receiver]);
            }
            const derived = originalExtends.apply(target, args);
            return typeof derived === 'object' && derived !== null ? proxy(derived) : derived;
          };
        }
        const wrapped = recipeClient.propertyOf(receiver, target, prop);
        return wrapped ? wrapped.value : Reflect.get(target, prop);
      },
    });
  return proxy(extendedClient);
};
