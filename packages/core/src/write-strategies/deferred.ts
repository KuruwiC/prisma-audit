/**
 * Deferred Write Strategy
 *
 * @module write-strategies/deferred
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import { getRuntimeContext } from '../runtime-context.js';
import type { AuditContext } from '../types.js';
import type { WriteErrorHandler, WriteFn, WriteResult, WriteStrategyInput } from './types.js';
import { createBaseClientWriteFn } from './utils.js';

const createDeferredExecutor = (
  logs: AuditLogData[],
  context: AuditContext,
  baseClientWriteFn: (logsToWrite: AuditLogData[]) => Promise<void>,
  customWriter: WriteFn | undefined,
  errorHandler: WriteErrorHandler,
): (() => Promise<void>) => {
  return async (): Promise<void> => {
    try {
      if (customWriter) {
        await customWriter(logs, context, baseClientWriteFn);
      } else {
        await baseClientWriteFn(logs);
      }
    } catch (error) {
      const errorObject = error instanceof Error ? error : new Error(String(error));
      await errorHandler(errorObject, 'deferred audit log write');
    }
  };
};

const enqueueDeferredWrite = (executor: () => Promise<void>): void => {
  const transaction = getRuntimeContext()?.transaction;

  // The deferred strategy is only selected when a transaction scope exists, and
  // the scope owner always provides the queue. Absence means no owner would ever
  // drain it, so enqueueing would silently drop the write — stay a no-op instead.
  if (!transaction) {
    return;
  }

  transaction.deferredWrites.push(executor);
};

/**
 * Deferred write strategy
 *
 * Queues audit logs to execute after transaction commits, using baseClient
 * to avoid "transaction already closed" errors.
 *
 * @remarks
 * Used when inside transaction and awaitWrite is false.
 * Errors handled via errorHandler without affecting main transaction.
 *
 * @example
 * ```typescript
 * const result = writeDeferredInTransaction({
 *   logs, context, manager, auditLogModel: 'auditLog',
 *   writer: customWriter, handleError, writeExecutor,
 * });
 * await result.execute(); // Execute after commit
 * ```
 */
export const writeDeferredInTransaction = (input: WriteStrategyInput): WriteResult => {
  const { logs, context, manager, auditLogModel, writer, handleError, writeExecutor } = input;

  const queuedAt = new Date();
  const baseClientWriteFn = createBaseClientWriteFn(manager, auditLogModel, writeExecutor);
  const deferredExecutor = createDeferredExecutor(logs, context, baseClientWriteFn, writer, handleError);

  enqueueDeferredWrite(deferredExecutor);

  return {
    _tag: 'Deferred',
    queuedAt,
    execute: deferredExecutor,
  };
};
