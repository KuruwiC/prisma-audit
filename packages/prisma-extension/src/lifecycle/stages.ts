/**
 * Lifecycle Stage Dependencies and Implementation
 *
 * Defines the dependencies required for each stage of the audit lifecycle pipeline
 * and provides factory functions to create type-safe lifecycle stages.
 */

import type {
  AggregateConfigService,
  AuditContext,
  GlobalContextEnricherConfig,
  LoggableEntity,
  PreFetchResults,
  RedactConfig,
} from '@kuruwic/prisma-audit-core';
import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import { createPrismaClientManager, type PrismaClientManager } from '../client-manager/index.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import type { AuditLogData, PrismaAction } from '../types.js';
import type { EnrichedContext, ExecutedContext, FinalContext, InitialContext, PreparedContext } from './types.js';

/**
 * Stage dependencies interface
 *
 * Encapsulates all dependencies required by the lifecycle pipeline stages,
 * enabling dependency injection for testing and maintaining separation of concerns.
 */
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
const getModelName = (model: string | undefined): string => {
  if (!model) {
    throw new Error('[@prisma-audit] Operation model is undefined');
  }
  return model;
};

/**
 * Safely cast action to PrismaAction
 *
 * @remarks
 * Prisma provides action as a string. We validate it matches our expected
 * action types at the type level, though runtime validation could be added
 * if needed for extra safety.
 */
const toPrismaAction = (action: string): PrismaAction => {
  // Runtime validation could be added here, but for performance we trust
  // that Prisma provides valid action strings
  return action as PrismaAction;
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

/**
 * Safely cast result to record
 *
 * @remarks
 * Prisma operation results are dynamic. This helper documents that we expect
 * a record-like structure for audit logging purposes.
 */
const toResultRecord = (result: unknown): Record<string, unknown> => {
  if (typeof result !== 'object' || result === null) {
    throw new Error('[@prisma-audit] Operation result must be an object');
  }
  return result as Record<string, unknown>;
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
    action: PrismaAction,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;

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
   *
   * @returns Path-based Map: path → record | null
   */
  preFetchNestedRecordsBeforeOperation: (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    args: Record<string, unknown>,
  ) => Promise<PreFetchResults>;

  /**
   * Get nested operation configuration with priority resolution
   *
   * Priority: Model-level > Global-level > Default (true)
   */
  getNestedOperationConfig: (modelName: string, operation: 'update' | 'delete') => { fetchBeforeOperation: boolean };

  /**
   * Enrich actor context from AuditContext
   *
   * Adds additional context data to the actor (e.g., role, department, email).
   * Called once per operation and the result is cached internally.
   */
  enrichActorContext: (
    context: AuditContext,
    actorConfig: GlobalContextEnricherConfig['actor'] | undefined,
    basePrisma: unknown,
  ) => Promise<unknown>;

  /**
   * Batch enrich entity contexts for multiple entities
   *
   * Adds additional context data to entities (e.g., title, status, author name).
   * Priority resolution: entityContext > context (from LoggableEntity config).
   *
   * NOTE: Now requires meta parameter for aggregate-aware enrichment.
   */
  batchEnrichEntityContexts: (
    entities: Record<string, unknown>[],
    entityConfig: LoggableEntity,
    basePrisma: unknown,
    meta: {
      aggregateType: string;
      aggregateCategory: string;
      aggregateId?: string;
    },
  ) => Promise<unknown[]>;

  /**
   * Build audit log data for an entity
   *
   * This function:
   * 1. Resolves aggregate roots for the entity
   * 2. Resolves entity ID using idResolver
   * 3. Determines actual action and before/after states
   * 4. Calculates field-level changes (before redaction)
   * 5. Applies redaction to sensitive data
   * 6. Enriches aggregate context per aggregate root (aggregate-aware)
   * 7. Builds audit log for each aggregate root
   *
   * Returns an empty array if:
   * - Entity config not found
   * - No aggregate roots found
   * - ID resolution fails
   * - Only excluded fields changed (for updates)
   *
   * NOTE: aggregateContext parameter removed. Now enriched internally per aggregate root.
   */
  buildAuditLog: (
    entity: Record<string, unknown>,
    action: PrismaAction,
    context: AuditContext,
    modelName: string,
    manager: PrismaClientManager,
    actorContext: unknown,
    entityContext: unknown,
    before: Record<string, unknown> | null | undefined,
    aggregateConfig: AggregateConfigService,
    excludeFields: string[] | undefined,
    redact: RedactConfig | undefined,
    includeRelations?: boolean,
  ) => Promise<AuditLogData[]>;

  /**
   * Build audit logs for nested records
   *
   * Detects nested operations in args and extracts nested records from result,
   * then generates audit logs for each nested record.
   *
   * EXTRACTION STRATEGY (Fallback approach):
   * 1. First, try to extract nested records from operation result (requires `include`)
   * 2. If no records found AND fetchBeforeOperation is enabled:
   *    - Fallback to re-fetching using IDs from pre-fetched data
   *    - This eliminates the need for `include` when fetchBeforeOperation: true
   *
   * CONSISTENCY TRADEOFFS:
   * - With `include`: Atomic, consistent data from the same operation
   * - With refetch fallback: Non-atomic, may capture state modified by other processes
   * - Refetch may happen outside user's transaction
   * - For best consistency, use `include` in your operations
   */
  buildNestedAuditLogs: (
    modelName: string,
    args: Record<string, unknown>,
    result: unknown,
    context: AuditContext,
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    actorContext: unknown,
    preFetchResults?: PreFetchResults,
  ) => Promise<AuditLogData[]>;

  /**
   * Aggregate configuration service
   *
   * Provides centralized access to aggregate mapping configuration:
   * - getEntityConfig(modelName): Get entity configuration
   * - isLoggable(modelName): Check if model is configured for audit logging
   * - getAllLoggableModels(): Get all loggable model names
   * - getMapping(): Get the entire aggregate mapping
   */
  aggregateConfig: AggregateConfigService;

  /**
   * Global exclude fields configuration
   *
   * Fields to exclude when calculating changes (e.g., updatedAt, createdAt).
   * Can be overridden by per-entity excludeFields in LoggableEntity config.
   */
  excludeFields: string[];

  /**
   * Redaction configuration
   *
   * Controls sensitive data handling in audit logs.
   * Fields specified here will be redacted/masked in before/after/changes.
   */
  redact?: RedactConfig;

  /**
   * Base Prisma client
   *
   * Non-transactional Prisma client reference for:
   * - Writing audit logs
   * - Resolving relations
   * - Enrichment queries (when not in transaction)
   */
  basePrisma: PrismaClientWithDynamicAccess;

  /**
   * Global context enricher configuration
   *
   * Configuration for actor, entity, and aggregate context enrichment.
   * See `GlobalContextEnricherConfig` from '@kuruwic/prisma-audit-core' for details.
   */
  contextEnricher?: GlobalContextEnricherConfig;
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
const shouldFetchBeforeState = (
  action: string,
  modelName: string,
  getConfig: (modelName: string, operation: 'update' | 'delete') => { fetchBeforeOperation: boolean },
): boolean => {
  if (action === AUDIT_ACTION.UPSERT) {
    return true;
  }

  if (action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE) {
    const operationConfig = getConfig(modelName, action as 'update' | 'delete');
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
    if (shouldFetchBeforeState(action, modelName, deps.getNestedOperationConfig)) {
      beforeState = await deps.fetchBeforeState(clientToUse, modelName, toPrismaAction(action), operationArgs);
    }

    const nestedPreFetchResults = await deps.preFetchNestedRecordsBeforeOperation(
      clientToUse,
      modelName,
      operationArgs,
    );

    return {
      ...context,
      beforeState,
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
 * Creates the enrich-contexts lifecycle stage
 *
 * This stage:
 * 1. Enriches actor context via enrichActorContext
 * 2. Gets entity config via aggregateConfig.getEntityConfig
 * 3. Enriches entity context via batchEnrichEntityContexts (if entity config exists)
 *
 * NOTE: aggregateContext is no longer enriched at this stage. It is now enriched
 * per aggregate root inside buildAuditLog for aggregate-aware context.
 *
 * @example
 * ```typescript
 * const stage = createEnrichContextsStage({
 *   enrichActorContext,
 *   batchEnrichEntityContexts,
 *   aggregateConfig,
 *   contextEnricher,
 * });
 *
 * const enrichedContext = await stage(executedContext);
 * console.log(enrichedContext.actorContext); // { role: 'admin', department: 'Engineering' }
 * console.log(enrichedContext.entityContext); // { title: 'New Title', authorName: 'John Doe' }
 * ```
 */
export const createEnrichContextsStage = (
  deps: Pick<
    StageDependencies,
    'enrichActorContext' | 'batchEnrichEntityContexts' | 'aggregateConfig' | 'contextEnricher'
  >,
): ((context: ExecutedContext) => Promise<EnrichedContext>) => {
  return async (context: ExecutedContext): Promise<EnrichedContext> => {
    const { operation, auditContext, result, clientToUse } = context;
    const modelName = getModelName(operation.model);

    const actorContext = await deps.enrichActorContext(auditContext, deps.contextEnricher?.actor, clientToUse);

    const entityConfig = deps.aggregateConfig.getEntityConfig(modelName);

    let entityContext: unknown | null = null;

    if (entityConfig) {
      // NOTE: entityContext is shared across all aggregates, so we pass
      // temporary meta information (actual aggregate info is not needed here)
      const tempMeta = {
        aggregateType: modelName,
        aggregateCategory: 'model',
      };

      const enrichedContexts = await deps.batchEnrichEntityContexts(
        [toResultRecord(result)],
        entityConfig,
        clientToUse,
        tempMeta,
      );
      entityContext = enrichedContexts[0] ?? null;
    }

    return {
      ...context,
      actorContext,
      entityContext,
    };
  };
};

/**
 * Build main audit logs for an entity
 *
 * Creates a Prisma client manager and calls buildAuditLog with all required parameters.
 *
 * NOTE: aggregateContext parameter removed. Now enriched internally per aggregate root.
 *
 * @internal
 */
const buildMainAuditLogs = async (
  context: EnrichedContext,
  deps: Pick<StageDependencies, 'buildAuditLog' | 'aggregateConfig' | 'excludeFields' | 'redact' | 'basePrisma'>,
): Promise<AuditLogData[]> => {
  const manager = createPrismaClientManager(deps.basePrisma, context.auditContext);

  return deps.buildAuditLog(
    toResultRecord(context.result),
    toPrismaAction(context.operation.action),
    context.auditContext,
    getModelName(context.operation.model),
    manager,
    context.actorContext,
    context.entityContext,
    context.beforeState,
    deps.aggregateConfig,
    deps.excludeFields,
    deps.redact,
  );
};

/**
 * Build nested audit logs from operation result
 *
 * Handles extraction of nested records from the operation result and generates
 * audit logs for each nested entity.
 *
 * @internal
 */
const buildNestedLogsFromResult = async (
  context: EnrichedContext,
  deps: Pick<StageDependencies, 'buildNestedAuditLogs'>,
): Promise<AuditLogData[]> => {
  return deps.buildNestedAuditLogs(
    getModelName(context.operation.model),
    toArgsRecord(context.operation.args),
    context.result,
    context.auditContext,
    context.clientToUse,
    context.actorContext,
    context.nestedPreFetchResults,
  );
};

/**
 * Creates the build-logs lifecycle stage
 *
 * This stage:
 * 1. Builds main audit log via buildAuditLog
 * 2. Builds nested audit logs via buildNestedAuditLogs
 * 3. Combines logs into a single array [mainLog, ...nestedLogs]
 *
 * @example
 * ```typescript
 * const stage = createBuildLogsStage({
 *   buildAuditLog,
 *   buildNestedAuditLogs,
 * });
 *
 * const finalContext = await stage(enrichedContext);
 * console.log(finalContext.logs); // [mainLog, nestedLog1, nestedLog2]
 * ```
 */
export const createBuildLogsStage = (
  deps: Pick<
    StageDependencies,
    'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'redact' | 'basePrisma'
  >,
): ((context: EnrichedContext) => Promise<FinalContext>) => {
  return async (context: EnrichedContext): Promise<FinalContext> => {
    const mainLogs = await buildMainAuditLogs(context, deps);

    const nestedLogs = await buildNestedLogsFromResult(context, deps);

    const allLogs = [...mainLogs, ...nestedLogs];

    return {
      ...context,
      logs: allLogs,
    };
  };
};
