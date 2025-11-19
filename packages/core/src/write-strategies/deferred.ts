/**
 * Deferred Write Strategy
 *
 * @module write-strategies/deferred
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import type { AuditContext } from '../types.js';
import type { DbClientManager, WriteExecutor } from './interfaces.js';
import type { WriteFn, WriteResult } from './types.js';
import { createBaseClientWriteFn } from './utils.js';

type ErrorHandler = (error: Error, operationDescription: string) => void;

const createDeferredExecutor = (
  logs: AuditLogData[],
  context: AuditContext,
  baseClientWriteFn: (logsToWrite: AuditLogData[]) => Promise<void>,
  customWriter: WriteFn | undefined,
  errorHandler: ErrorHandler,
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
      errorHandler(errorObject, 'deferred audit log write');
    }
  };
};

const enqueueDeferredWrite = (context: AuditContext, executor: () => Promise<void>): void => {
  const contextWithQueue = context as AuditContext & {
    _deferredWrites?: Array<() => Promise<void>>;
  };

  if (!contextWithQueue._deferredWrites) {
    contextWithQueue._deferredWrites = [];
  }

  contextWithQueue._deferredWrites.push(executor);
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
 * const result = writeDeferredInTransaction(
 *   logs, context, manager, 'auditLog',
 *   customWriter, errorHandler, writeExecutor
 * );
 * await result.execute(); // Execute after commit
 * ```
 */
export const writeDeferredInTransaction = (
  logs: AuditLogData[],
  context: AuditContext,
  manager: DbClientManager,
  auditLogModelName: string,
  customWriter: WriteFn | undefined,
  errorHandler: ErrorHandler,
  writeExecutor: WriteExecutor,
): WriteResult => {
  const queuedAt = new Date();
  const baseClientWriteFn = createBaseClientWriteFn(manager, auditLogModelName, writeExecutor);
  const deferredExecutor = createDeferredExecutor(logs, context, baseClientWriteFn, customWriter, errorHandler);

  enqueueDeferredWrite(context, deferredExecutor);

  return {
    _tag: 'Deferred',
    queuedAt,
    execute: deferredExecutor,
  };
};
