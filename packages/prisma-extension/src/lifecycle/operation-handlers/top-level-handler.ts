/**
 * Top-Level Operation Handler Module
 *
 * Handles single entity operations (create, update, delete, upsert) with transaction
 * management and write strategy coordination.
 *
 * @module lifecycle/operation-handlers/top-level-handler
 */

import type { AggregateConfigService, AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { OperationContext } from '../../types.js';
import { withOptionalTransaction } from '../transaction-wrapper.js';
import { executeAuditedOperation, type OperationExecutorDependencies } from './operation-executor.js';

/** Dependencies for handling top-level operations */
export interface TopLevelHandlerDependencies extends OperationExecutorDependencies {
  /** Aggregate configuration service */
  aggregateConfig: AggregateConfigService;
  /** Audit context provider for transaction coordination */
  provider: AuditContextProvider;
  /** Global awaitWrite setting */
  awaitWrite: boolean;
  /** Per-entity awaitWrite override function */
  awaitWriteIf?: (modelName: string, tags: string[]) => boolean;
}

/**
 * Handle single entity operations with transaction management
 *
 * Determines awaitWrite setting (per-entity or global), wraps in transaction if necessary,
 * and executes via executeAuditedOperation.
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
  const modelName = operation.model;
  const entityConfig = modelName ? deps.aggregateConfig.getEntityConfig(modelName) : undefined;
  const shouldAwaitForModel =
    deps.awaitWriteIf && entityConfig?.tags && modelName
      ? deps.awaitWriteIf(modelName, entityConfig.tags)
      : deps.awaitWrite;

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
