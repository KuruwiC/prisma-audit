/**
 * Top-Level Operation Handler Module
 *
 * Handles single entity operations (create, update, delete, upsert) with transaction
 * management and write strategy coordination.
 *
 * @module lifecycle/operation-handlers/top-level-handler
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { OperationContext } from '../../types.js';
import { withOptionalTransaction } from '../transaction-wrapper.js';
import { executeAuditedOperation, type OperationExecutorDependencies } from './operation-executor.js';

/** Dependencies for handling top-level operations */
export interface TopLevelHandlerDependencies extends OperationExecutorDependencies {
  /** Audit context provider for transaction coordination */
  provider: AuditContextProvider;
  /** Whether the caller's operation awaits the audit-log write for a model */
  resolveAwaitWrite: (modelName: string) => boolean;
}

/**
 * Handle single entity operations with transaction management
 *
 * Wraps the operation in a transaction when the model's audit-log write is awaited, and
 * executes via executeAuditedOperation.
 *
 * @param operation - Operation context (model, action, args)
 * @param context - Audit context
 * @param baseClient - Base Prisma client
 * @param _query - Original query function (unused, preserved for compatibility)
 * @param deps - Dependencies (executor deps + transaction settings)
 * @returns Operation result
 */
export const handleTopLevelOperation = async (
  operation: OperationContext,
  context: AuditContext,
  baseClient: PrismaClientWithDynamicAccess,
  _query: (args: unknown) => Promise<unknown>,
  deps: TopLevelHandlerDependencies,
): Promise<unknown> => {
  // A model-less operation produces no audit log, so there is no write to await.
  const modelName = operation.model;
  const shouldAwaitForModel = modelName !== undefined && deps.resolveAwaitWrite(modelName);

  const executeOperation = async (
    txContext: AuditContext,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  ): Promise<unknown> => {
    return executeAuditedOperation(operation, txContext, clientToUse, deps);
  };

  const wrapper = withOptionalTransaction(
    {
      shouldWrap: shouldAwaitForModel,
      context,
      basePrisma: baseClient,
    },
    deps.provider,
  );

  return wrapper(executeOperation);
};
