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
import { isCallerMutationError, runCallerMutation } from '../../utils/caller-mutation-error.js';
import { getPrisma, type PrismaWithDMMF } from '../../utils/schema-metadata.js';
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
  /** Called when pipeline (fetch/enrich/build) fails, before rethrowing */
  onPipelineError?: (error: Error) => Promise<void>;
}

/**
 * Execute an audited operation through lifecycle pipeline
 *
 * Orchestrates: query function creation → pipeline execution → Date hydration → audit log writes
 *
 * @param operation - Operation context (model, action, args)
 * @param txContext - App-owned audit context (actor + request metadata)
 * @param clientToUse - Prisma client (base or transactional)
 * @param deps - Dependencies (stages, write function, base client)
 * @returns Operation result
 * @throws {Error} If the caller's own database mutation fails (e.g. a unique constraint
 * violation), that error is rethrown as-is, skipping `deps.onPipelineError` and message
 * wrapping. Any other pipeline failure (fetch-before-state / enrich / build) calls
 * `deps.onPipelineError` and is rethrown wrapped with `cause`.
 */
export const executeAuditedOperation = async (
  operation: OperationContext,
  txContext: AuditContext,
  clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  deps: OperationExecutorDependencies,
): Promise<unknown> => {
  const executeQuery = async (args: unknown): Promise<unknown> => {
    const action = operation.action as string;
    const modelDelegate = clientToUse[operation.model as string] as Record<string, unknown>;

    if (!modelDelegate || typeof modelDelegate[action] !== 'function') {
      throw new Error(`Model "${operation.model}" or action "${action}" not found`);
    }

    // This is the caller's own database mutation, not audit-support work — tag any
    // failure so the catch below can tell it apart from a fetch/enrich/build failure.
    return runCallerMutation(() => (modelDelegate[action] as (args: unknown) => Promise<unknown>)(args));
  };

  const initialContext: InitialContext = {
    operation,
    auditContext: txContext,
    clientToUse,
    query: executeQuery,
  };

  let finalContext: FinalContext;
  try {
    finalContext = await runLifecyclePipeline<InitialContext, FinalContext>(
      initialContext,
      deps.lifecycleStages as ReadonlyArray<(context: InitialContext) => Promise<FinalContext>>,
    );
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

    if (isCallerMutationError(error)) {
      // The caller's own database operation failed on its own terms (e.g. a unique
      // constraint violation), not an audit failure: rethrow it as-is, without calling
      // `onPipelineError` or wrapping the message.
      throw error;
    }

    if (deps.onPipelineError) {
      await deps.onPipelineError(error);
    }

    // An audit-stage failure (fetch-before-state / enrich / build). Wrap it with `cause`
    // rather than editing its `message`: the caller may hold a reference to the same error.
    throw new Error(
      `[@prisma-audit] Audited operation failed for model "${operation.model}" and action "${operation.action}": ${error.message}`,
      { cause: error },
    );
  }

  let prismaNamespace: PrismaWithDMMF | undefined;
  try {
    prismaNamespace = getPrisma(deps.basePrisma);
  } catch {
    // Prisma namespace not available — date hydration falls back to ['id']
  }
  const result = await refetchForDateHydration(finalContext.result, operation, clientToUse, prismaNamespace);

  await deps.writeAuditLogs(finalContext.logs as AuditLogData[], deps.basePrisma);

  return result;
};
