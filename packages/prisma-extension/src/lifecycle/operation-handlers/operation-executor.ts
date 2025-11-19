/**
 * Operation Executor Module
 *
 * Executes audited operations through the lifecycle pipeline:
 * fetch → execute → enrich → build → write
 *
 * @module lifecycle/operation-handlers/operation-executor
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { AuditLogData, OperationContext } from '../../types.js';
import { runLifecyclePipeline } from '../pipeline.js';
import type { FinalContext, InitialContext } from '../types.js';
import { refetchForDateHydration } from './date-hydration.js';

/** Dependencies for executing audited operations */
export interface OperationExecutorDependencies {
  /** Lifecycle stages to execute */
  lifecycleStages: ReadonlyArray<(context: unknown) => Promise<unknown>>;
  /** Function to write audit logs */
  writeAuditLogs: (logs: AuditLogData[], baseClient: PrismaClientWithDynamicAccess) => Promise<void>;
  /** Base Prisma client for audit log writes */
  basePrisma: PrismaClientWithDynamicAccess;
}

/**
 * Execute an audited operation through lifecycle pipeline
 *
 * Orchestrates: query function creation → pipeline execution → Date hydration → audit log writes
 *
 * @param operation - Operation context (model, action, args)
 * @param txContext - Audit context (may contain transactional client)
 * @param clientToUse - Prisma client (base or transactional)
 * @param deps - Dependencies (stages, write function, base client)
 * @returns Operation result
 * @throws {Error} If operation execution or audit logging fails
 */
export const executeAuditedOperation = async (
  operation: OperationContext,
  txContext: AuditContext,
  clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  deps: OperationExecutorDependencies,
): Promise<unknown> => {
  try {
    const executeQuery = async (args: unknown): Promise<unknown> => {
      const action = operation.action as string;
      const modelDelegate = clientToUse[operation.model as string] as Record<string, unknown>;

      if (!modelDelegate || typeof modelDelegate[action] !== 'function') {
        throw new Error(`Model "${operation.model}" or action "${action}" not found`);
      }

      return (modelDelegate[action] as (args: unknown) => Promise<unknown>)(args);
    };

    const initialContext: InitialContext = {
      operation,
      auditContext: txContext,
      clientToUse,
      query: executeQuery,
    };

    const finalContext = await runLifecyclePipeline<InitialContext, FinalContext>(
      initialContext,
      deps.lifecycleStages as ReadonlyArray<(context: InitialContext) => Promise<FinalContext>>,
    );

    const result = await refetchForDateHydration(finalContext.result, operation, clientToUse);

    await deps.writeAuditLogs(finalContext.logs as AuditLogData[], deps.basePrisma);

    return result;
  } catch (error) {
    const errorWithContext = error instanceof Error ? error : new Error(String(error));
    errorWithContext.message = `[@prisma-audit] Audited operation failed for model "${operation.model}" and action "${operation.action}": ${errorWithContext.message}`;
    throw errorWithContext;
  }
};
