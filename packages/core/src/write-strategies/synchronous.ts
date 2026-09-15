/**
 * Synchronous Write Strategy
 *
 * @module write-strategies/synchronous
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import type { AuditContext } from '../types.js';
import type { WriteFn, WriteResult, WriteStrategyInput } from './types.js';
import { createDefaultWriteFn } from './utils.js';

const executeWriteOperation = async (
  logs: AuditLogData[],
  context: AuditContext,
  defaultWriteFn: (logs: AuditLogData[]) => Promise<void>,
  customWriter?: WriteFn,
): Promise<void> => {
  if (customWriter) {
    await customWriter(logs, context, defaultWriteFn);
  } else {
    await defaultWriteFn(logs);
  }
};

/**
 * Synchronous write strategy
 *
 * Blocks until audit logs are written, maintaining transactional consistency.
 *
 * @remarks
 * Used when the model's write is awaited (`WriteStrategyConfig.shouldAwaitWrite` returns true).
 * Write errors propagate to caller.
 *
 * @example
 * ```typescript
 * const result = await writeSynchronously({
 *   logs, context, manager, auditLogModel: 'auditLog',
 *   writer: undefined, handleError, writeExecutor,
 * });
 * ```
 */
export const writeSynchronously = async (input: WriteStrategyInput): Promise<WriteResult> => {
  const { logs, context, manager, auditLogModel, writer, writeExecutor } = input;

  if (logs.length === 0) {
    return {
      _tag: 'Immediate',
      createdAt: new Date(),
    };
  }

  const defaultWriteFn = createDefaultWriteFn(manager, auditLogModel, writeExecutor);

  await executeWriteOperation(logs, context, defaultWriteFn, writer);

  return {
    _tag: 'Immediate',
    createdAt: new Date(),
  };
};
