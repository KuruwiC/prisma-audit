/**
 * Batch transaction
 *
 * A batch `$transaction([...])` is one request Prisma sends once every operation of the list has
 * reached it, so an audit query cannot join it: the audit rows depend on what the operations
 * return. When an audit of the batch can be awaited, the batch runs instead as one interactive
 * transaction on the client it was called on. Prisma's operations are lazy, so the transaction
 * triggers them one after another, in the order of the list, while the runtime scope names the
 * transaction's client as the batch client; the extension hook re-issues each triggered operation
 * on that client, where it runs as an ordinary operation of an interactive transaction, audited or
 * not.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import type { TransactionalPrismaClient } from '../internal-types.js';
import { getModelDelegate, getModelOperation } from '../utils/model-accessor.js';
import { drainAfterCommit, enterTransaction, withScope } from './scope.js';

export type TransactionMethod = (...args: unknown[]) => Promise<unknown>;

/** The one option of a batch `$transaction([...])`, which an interactive transaction takes as well */
interface BatchTransactionOptions {
  readonly isolationLevel?: unknown;
}

const isPrismaPromise = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && Reflect.get(value, Symbol.toStringTag) === 'PrismaPromise';

/** The operations of a batch `$transaction` call, when it is one Prisma would accept */
export const batchOperationsOf = (args: readonly unknown[]): readonly PromiseLike<unknown>[] | undefined => {
  const [operations] = args;
  if (!Array.isArray(operations) || operations.length === 0 || !operations.every(isPrismaPromise)) {
    return undefined;
  }
  return operations;
};

export interface BatchTransactionInput {
  readonly operations: readonly PromiseLike<unknown>[];
  readonly options: unknown;
  readonly auditContext: AuditContext;
  readonly provider: AuditContextProvider;
  /** The `$transaction` of the client the batch was called on */
  readonly originalTransaction: TransactionMethod;
  readonly target: object;
}

const interactiveOptionsOf = (options: unknown): BatchTransactionOptions[] => {
  const isolationLevel =
    typeof options === 'object' && options !== null ? (options as BatchTransactionOptions).isolationLevel : undefined;
  return isolationLevel === undefined ? [] : [{ isolationLevel }];
};

/**
 * Runs the batch as one interactive transaction and resolves with the operations' results in
 * order. The transaction takes the caller's `isolationLevel` and otherwise the client's own
 * interactive transaction options. The writes queued on it start once it has committed; when it
 * rolls back, they are discarded unrun.
 */
export const runBatchAsInteractiveTransaction = async (input: BatchTransactionInput): Promise<unknown[]> => {
  const { operations, options, auditContext, provider, originalTransaction, target } = input;
  const deferredWrites: Array<() => Promise<void>> = [];

  const runOperations = (tx: TransactionalPrismaClient): Promise<unknown[]> =>
    enterTransaction(provider, auditContext, { client: tx, deferredWrites }, () =>
      withScope({ batchClient: tx }, async () => {
        const results: unknown[] = [];
        for (const operation of operations) {
          results.push(await operation);
        }
        return results;
      }),
    );

  const results = (await originalTransaction.apply(target, [
    runOperations,
    ...interactiveOptionsOf(options),
  ])) as unknown[];
  drainAfterCommit(deferredWrites);
  return results;
};

export interface TriggeredOperation {
  readonly model?: string;
  readonly operation: string;
  readonly args: unknown;
}

/**
 * Re-issues an operation of the batch on the batch client and resolves with its result. The
 * re-issued call runs outside the batch client's scope, as an operation of the interactive
 * transaction, and is awaited there so that Prisma starts it inside that scope. A model operation
 * runs on the model's delegate; a raw one on the client's method of the same name, with the
 * arguments the hook received (the `[query, ...values]` list of the unsafe variants spread).
 */
export const reissueOnBatchClient = (batchClient: TransactionalPrismaClient, triggered: TriggeredOperation) =>
  withScope({ batchClient: undefined }, async (): Promise<unknown> => {
    const { model, operation, args } = triggered;
    if (model) {
      const run = getModelOperation(getModelDelegate(batchClient, model), operation);
      if (!run) {
        throw new Error(`Model "${model}" or action "${operation}" not found`);
      }
      return await run(args);
    }
    const method = batchClient[operation];
    if (typeof method !== 'function') {
      throw new Error(`Client method "${operation}" not found`);
    }
    return await Reflect.apply(method, batchClient, Array.isArray(args) ? args : [args]);
  });
