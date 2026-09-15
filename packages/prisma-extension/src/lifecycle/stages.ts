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
  NestedPreFetchResults,
  RedactConfig,
  SerializationConfig,
  UpsertBranch,
} from '@kuruwic/prisma-audit-core';
import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import type { BuildAuditLogInput } from '../audit-log-builder/index.js';
import { createPrismaClientManager } from '../client-manager/index.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import type { AuditLogData, PrismaAction } from '../types.js';
import { createSchemaMetadataFromDMMF, type PrismaWithDMMF } from '../utils/schema-metadata.js';
import {
  buildAggregateDataForEntity,
  enrichAggregateContexts,
  resolveAndFilterSurvivors,
} from './batch-aggregate-resolver.js';
import type { BuildNestedAuditLogsParams } from './nested-handlers/index.js';
import type {
  BeforeStateResult,
  EnrichedContext,
  ExecutedContext,
  FinalContext,
  InitialContext,
  PreparedContext,
} from './types.js';

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
   * Adds additional context data to entities (e.g., title, status, author name)
   * using the entity's `context` enricher.
   */
  batchEnrichEntityContexts: (
    entities: Record<string, unknown>[],
    entityConfig: LoggableEntity,
    basePrisma: unknown,
  ) => Promise<unknown[]>;

  /**
   * Build audit log data for an entity
   *
   * Aggregate roots and contexts are resolved externally and passed in,
   * following the same pattern as actor and entity enrichment.
   *
   * Returns an empty array if:
   * - Entity config not found
   * - No aggregate roots found
   * - ID resolution fails
   * - Only excluded fields changed (for updates)
   */
  buildAuditLog: (input: BuildAuditLogInput) => Promise<AuditLogData[]>;

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
  buildNestedAuditLogs: (input: BuildNestedAuditLogsParams) => Promise<AuditLogData[]>;

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

  /** Custom serialization configuration for non-JSON-safe types */
  serialization?: SerializationConfig;

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
   * Prisma namespace passed in the client options
   *
   * Its DMMF identifies relation fields, which are removed from before/after state.
   */
  Prisma: PrismaWithDMMF;

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
 * record reads `beforeStateResult` — see `buildMainAuditLogs`, which skips an upsert's
 * audit entry when the fetch failed rather than recording it as `action: 'create'`.
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
      beforeStateResult = await deps.fetchBeforeState(clientToUse, modelName, toPrismaAction(action), operationArgs);
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
 * Creates the enrich-contexts lifecycle stage
 *
 * This stage:
 * 1. Enriches actor context via enrichActorContext
 * 2. Gets entity config via aggregateConfig.getEntityConfig
 * 3. Enriches entity context via batchEnrichEntityContexts (if entity config exists)
 *
 * Aggregate context enrichment is handled separately in the build-logs stage
 * via enrichAggregateContexts, following the same pre-resolution pattern.
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
      const enrichedContexts = await deps.batchEnrichEntityContexts(
        [toResultRecord(result)],
        entityConfig,
        clientToUse,
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
 * @internal
 */
const buildMainAuditLogs = async (
  context: EnrichedContext,
  deps: Pick<
    StageDependencies,
    'buildAuditLog' | 'aggregateConfig' | 'excludeFields' | 'redact' | 'serialization' | 'basePrisma' | 'Prisma'
  >,
): Promise<AuditLogData[]> => {
  const manager = createPrismaClientManager(deps.basePrisma);
  const modelName = getModelName(context.operation.model);
  const entity = toResultRecord(context.result);

  const entityConfig = deps.aggregateConfig.getEntityConfig(modelName);
  if (!entityConfig) {
    return [];
  }

  // Exhaustive switch so a new `BeforeStateResult` variant fails to compile at the
  // `never` check instead of being silently ignored.
  //
  // Only 'error' on an `upsert` changes anything. resolveBeforeAndAfterStates (core)
  // resolves an upsert with no before-state to 'create', and a failed fetch cannot tell
  // an absent row from an existing one, so the entry is skipped rather than risk logging
  // an update as a create. fetchBeforeState already reported the failure to the observer.
  // `upsert` always requests the fetch (see `shouldFetchBeforeState`), so it never sees
  // 'notRequested'; 'found' / 'notFound' / 'notRequested' fall through for every action.
  switch (context.beforeStateResult._tag) {
    case 'found':
    case 'notFound':
    case 'notRequested':
      break;
    case 'error':
      if (context.operation.action === AUDIT_ACTION.UPSERT) {
        return [];
      }
      break;
    default: {
      const exhaustiveCheck: never = context.beforeStateResult;
      console.error(`[@prisma-audit] Unhandled BeforeStateResult tag: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const survivors = await resolveAndFilterSurvivors([entity], entityConfig, manager.activeClient);
  if (survivors.length === 0) {
    return [];
  }

  const aggregateContextLookup = await enrichAggregateContexts(
    survivors,
    entityConfig,
    manager.activeClient,
    deps.aggregateConfig.getEntityConfigByType,
  );

  const survivor = survivors[0];
  if (!survivor) {
    return [];
  }
  const aggregateData = buildAggregateDataForEntity(
    survivor.entityIndex,
    survivor.aggregateRoots,
    aggregateContextLookup,
  );

  const relationFields = new Set(
    createSchemaMetadataFromDMMF(deps.Prisma)
      .getRelationFields(modelName)
      .map((f) => f.name),
  );

  return deps.buildAuditLog({
    entity,
    action: toPrismaAction(context.operation.action),
    context: context.auditContext,
    modelName,
    manager,
    actorContext: context.actorContext,
    entityContext: context.entityContext,
    before: context.beforeState,
    aggregateConfig: deps.aggregateConfig,
    excludeFields: deps.excludeFields,
    redact: deps.redact,
    aggregateData,
    serialization: deps.serialization,
    relationFieldNames: relationFields,
  });
};

/**
 * Build nested audit logs from operation result
 *
 * Handles extraction of nested records from the operation result and generates
 * audit logs for each nested entity.
 *
 * For a top-level upsert, only the nested writes of the branch that executed are audited. When the
 * before-state fetch failed or was not requested that branch is unknown, so the nested entries are
 * skipped, as the main entry is in `buildMainAuditLogs` (fetchBeforeState reports a failed fetch).
 *
 * @internal
 */
const buildNestedLogsFromResult = async (
  context: EnrichedContext,
  deps: Pick<StageDependencies, 'buildNestedAuditLogs'>,
): Promise<AuditLogData[]> => {
  let topLevelUpsertBranch: UpsertBranch | undefined;

  if (context.operation.action === AUDIT_ACTION.UPSERT) {
    switch (context.beforeStateResult._tag) {
      case 'found':
        topLevelUpsertBranch = 'update';
        break;
      case 'notFound':
        topLevelUpsertBranch = 'create';
        break;
      case 'error':
      case 'notRequested':
        return [];
      default: {
        const exhaustiveCheck: never = context.beforeStateResult;
        console.error(`[@prisma-audit] Unhandled BeforeStateResult tag: ${JSON.stringify(exhaustiveCheck)}`);
        return [];
      }
    }
  }

  return deps.buildNestedAuditLogs({
    modelName: getModelName(context.operation.model),
    args: toArgsRecord(context.operation.args),
    result: context.result,
    context: context.auditContext,
    prismaClient: context.clientToUse,
    actorContext: context.actorContext,
    nestedPreFetchResults: context.nestedPreFetchResults,
    topLevelUpsertBranch,
  });
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
    | 'buildAuditLog'
    | 'buildNestedAuditLogs'
    | 'aggregateConfig'
    | 'excludeFields'
    | 'redact'
    | 'serialization'
    | 'basePrisma'
    | 'Prisma'
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
