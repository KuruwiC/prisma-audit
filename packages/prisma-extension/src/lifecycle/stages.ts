/**
 * Lifecycle Stage Dependencies and Implementation
 *
 * Defines the dependencies required for each stage of the audit lifecycle pipeline
 * and provides factory functions to create type-safe lifecycle stages.
 */

import type { AuditAction } from '@kuruwic/prisma-audit-core';
import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import type { NestedPreFetchResults } from '../grammar/nested-operations.js';
import type { GetOperationConfig } from '../grammar/pre-fetch-selection.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { collectSingleOperationEvents } from '../pipeline/collect-events.js';
import type { RecordProducer } from '../pipeline/produce-records.js';
import type { SchemaMetadata } from '../schema/types.js';
import { isAuditableAction } from '../utils/extension-utils.js';
import type { UnresolvedDeleteEntityIdReporter } from './nested-handlers/delete-handler.js';
import type { BeforeStateResult, ExecutedContext, FinalContext, InitialContext, PreparedContext } from './types.js';

/**
 * Type-safe helpers for Prisma operation data
 *
 * These functions explicitly handle the dynamic nature of Prisma operations
 * while documenting the expected types and runtime behavior.
 */

/**
 * Safely extract model name from Prisma operation
 *
 * @remarks
 * Prisma operations have `model` as an optional string. This helper makes
 * the extraction explicit and handles the undefined case.
 */
export const getModelName = (model: string | undefined): string => {
  if (!model) {
    throw new Error('[@prisma-audit] Operation model is undefined');
  }
  return model;
};

/**
 * Narrow the action string Prisma provides to an audited action
 *
 * @remarks
 * `$allOperations` only routes audited actions into the pipeline, so this never fails there.
 */
export const toAuditAction = (action: string): AuditAction => {
  if (!isAuditableAction(action)) {
    throw new Error(`[@prisma-audit] Unsupported operation: ${action}`);
  }
  return action;
};

/**
 * Safely cast args to record
 *
 * @remarks
 * Prisma operation args are dynamic and untyped at the extension level.
 * This helper makes the cast explicit and documents the expected structure.
 */
const toArgsRecord = (args: unknown): Record<string, unknown> => {
  if (typeof args !== 'object' || args === null) {
    throw new Error('[@prisma-audit] Operation args must be an object');
  }
  return args as Record<string, unknown>;
};

export interface StageDependencies {
  /**
   * Fetch before state for update/delete operations
   *
   * Fetches the entity state before the operation executes, enabling proper
   * change tracking for updates and preserving state for deletes.
   */
  fetchBeforeState: (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    action: AuditAction,
    args: Record<string, unknown>,
  ) => Promise<BeforeStateResult>;

  /**
   * Pre-fetch nested records before operation execution
   *
   * Required for nested operations that need the "before" state:
   * - Upsert: Always pre-fetch to determine accurate action (create vs update)
   * - Update: Pre-fetch only if fetchBeforeOperation=true
   * - Delete: Pre-fetch only if fetchBeforeOperation=true
   * - ConnectOrCreate: Pre-fetch to determine if record existed (connect vs create)
   *
   * IMPORTANT: Must be called before the operation executes, otherwise records
   * will already be modified/deleted and unavailable.
   */
  preFetchNestedRecordsBeforeOperation: (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    args: Record<string, unknown>,
  ) => Promise<NestedPreFetchResults>;

  /**
   * Get nested operation configuration with priority resolution
   *
   * Priority: Model-level > Global-level > Default (true)
   */
  getNestedOperationConfig: GetOperationConfig;

  /** Schema metadata of the client: primary keys of the written rows and the nested-write grammar */
  schemaMetadata: SchemaMetadata;

  /**
   * Notified when a nested delete's primary key cannot be resolved; that entry is skipped
   * instead of being recorded with a partial or guessed key.
   */
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter;

  /** Resolve the collected events and compose them into audit records */
  produceRecords: RecordProducer;
}

/**
 * Lifecycle Stage Implementations
 */

/**
 * Determine if before-state should be fetched for an operation
 *
 * Rules:
 * - CREATE: No fetch needed (beforeState = null)
 * - UPSERT: Always fetch (need to detect if record exists)
 * - UPDATE/DELETE: Fetch only if fetchBeforeOperation config is enabled
 *
 * @internal
 */
const shouldFetchBeforeState = (action: string, modelName: string, getConfig: GetOperationConfig): boolean => {
  if (action === AUDIT_ACTION.UPSERT) {
    return true;
  }

  if (action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE) {
    const operationConfig = getConfig(modelName, action);
    return operationConfig.fetchBeforeOperation;
  }

  return false;
};

/**
 * Creates the fetch-before-state lifecycle stage
 *
 * This stage:
 * 1. Fetches before-state for update/delete operations (if configured via fetchBeforeOperation)
 * 2. Always fetches before-state for upsert operations (forced)
 * 3. Skips fetch for create operations (beforeState = null)
 * 4. Pre-fetches nested records before operation execution
 *
 * **TOCTOU note for upsert**: There is an inherent time gap between fetching
 * the before-state (findUnique) and executing the upsert. When `awaitWrite=true`,
 * both run inside the same transaction, mitigating this gap. When `awaitWrite=false`,
 * concurrent operations may cause the audited action (create vs update) to diverge
 * from what actually happened. This is an accepted trade-off because Prisma does not
 * expose which branch of an upsert was executed.
 *
 * **Fetch failure vs "not found" vs "not requested"**: `beforeState` collapses all
 * three outcomes to `null`; `beforeStateResult` (the full {@link BeforeStateResult})
 * keeps them apart. Anything that must not treat a failed or skipped fetch as an absent
 * record reads `beforeStateResult`: event collection skips an upsert's entries when the
 * fetch failed rather than recording them as `action: 'create'`.
 *
 * @example
 * ```typescript
 * const stage = createFetchBeforeStateStage({
 *   fetchBeforeState,
 *   preFetchNestedRecordsBeforeOperation,
 *   getNestedOperationConfig,
 * });
 *
 * const preparedContext = await stage(initialContext);
 * console.log(preparedContext.beforeState); // { id: 'post-1', title: 'Old Title' } or null
 * console.log(preparedContext.nestedPreFetchResults); // Map of pre-fetched nested records
 * ```
 */
export const createFetchBeforeStateStage = (
  deps: Pick<
    StageDependencies,
    'fetchBeforeState' | 'preFetchNestedRecordsBeforeOperation' | 'getNestedOperationConfig'
  >,
): ((context: InitialContext) => Promise<PreparedContext>) => {
  return async (context: InitialContext): Promise<PreparedContext> => {
    const { operation, clientToUse } = context;
    const { model, action, args } = operation;
    const modelName = getModelName(model);
    const operationArgs = toArgsRecord(args);

    let beforeState: Record<string, unknown> | null = null;
    // Stays 'notRequested' (not 'notFound') when `shouldFetchBeforeState` skips the fetch.
    let beforeStateResult: BeforeStateResult = { _tag: 'notRequested' };
    if (shouldFetchBeforeState(action, modelName, deps.getNestedOperationConfig)) {
      beforeStateResult = await deps.fetchBeforeState(clientToUse, modelName, toAuditAction(action), operationArgs);
      if (beforeStateResult._tag === 'found') {
        beforeState = beforeStateResult.data;
      }
      // An 'error' result was already reported to the observer by fetchBeforeState.
    }

    const nestedPreFetchResults = await deps.preFetchNestedRecordsBeforeOperation(
      clientToUse,
      modelName,
      operationArgs,
    );

    return {
      ...context,
      beforeState,
      beforeStateResult,
      nestedPreFetchResults,
    };
  };
};

/**
 * Creates the execute-operation lifecycle stage
 *
 * This stage:
 * 1. Executes the Prisma operation via context.query(context.operation.args)
 * 2. Adds the result to the context
 * 3. Handles async query operations correctly
 *
 * @example
 * ```typescript
 * const stage = createExecuteOperationStage();
 * const executedContext = await stage(preparedContext);
 * console.log(executedContext.result); // { id: 'post-1', title: 'New Title' }
 * ```
 */
export const createExecuteOperationStage = (): ((context: PreparedContext) => Promise<ExecutedContext>) => {
  return async (context: PreparedContext): Promise<ExecutedContext> => {
    const result = await context.query(context.operation.args);

    return {
      ...context,
      result,
    };
  };
};

/**
 * Creates the build-logs lifecycle stage
 *
 * Collects the mutation events of the executed operation (the top-level row, then the nested
 * records it wrote) and produces their audit records in one pass, so the actor is enriched once
 * and every written model's rows are enriched together.
 *
 * @example
 * ```typescript
 * const stage = createBuildLogsStage({ schemaMetadata, getNestedOperationConfig, produceRecords });
 *
 * const finalContext = await stage(executedContext);
 * console.log(finalContext.logs); // [mainLog, nestedLog1, nestedLog2]
 * ```
 */
export const createBuildLogsStage = (
  deps: Pick<
    StageDependencies,
    'schemaMetadata' | 'getNestedOperationConfig' | 'onUnresolvedDeleteEntityId' | 'produceRecords'
  >,
): ((context: ExecutedContext) => Promise<FinalContext>) => {
  return async (context: ExecutedContext): Promise<FinalContext> => {
    const events = await collectSingleOperationEvents(
      {
        modelName: getModelName(context.operation.model),
        action: toAuditAction(context.operation.action),
        args: toArgsRecord(context.operation.args),
        result: context.result,
        beforeStateResult: context.beforeStateResult,
        nestedPreFetchResults: context.nestedPreFetchResults,
        client: context.clientToUse,
      },
      deps,
    );

    const logs = await deps.produceRecords(events, context.auditContext);

    return { ...context, logs };
  };
};
