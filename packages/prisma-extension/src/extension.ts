/**
 * Prisma Audit Extension - Core Module
 *
 * Implements the main Prisma Client Extension for automatic audit logging with
 * transaction-aware writes, lifecycle pipeline processing, and nested operation support.
 *
 * @module extension
 * @see {@link createAuditLogExtension}
 * @see {@link PrismaAuditExtensionOptions}
 */

import type { AuditContext, ErrorStrategy, PreFetchResults } from '@kuruwic/prisma-audit-core';
import {
  AUDIT_ACTION,
  batchEnrichEntityContexts,
  createAggregateConfig,
  createErrorHandler,
  createWriteStrategySelector,
  DEFAULTS,
  enrichActorContext,
  getRuntimeContext,
  runWithRuntimeContext,
  type WriteResult,
} from '@kuruwic/prisma-audit-core';
import { createPrismaWriteExecutor } from './adapters/write-executor.js';
import { buildAuditLog } from './audit-log-builder/index.js';
import { createPrismaClientManager } from './client-manager/index.js';
import { getNestedOperationConfig, validateFieldConflicts } from './config/index.js';
import type {
  ExtensionParams,
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from './internal-types.js';
import { createBatchBuildLogsStage, createBatchEnrichContextsStage } from './lifecycle/batch-stages.js';
import { type BuildNestedAuditLogsParams, buildNestedAuditLogs } from './lifecycle/nested-handlers/index.js';
import { handleTopLevelOperation, type TopLevelHandlerDependencies } from './lifecycle/operation-handlers/index.js';
import { runLifecyclePipeline } from './lifecycle/pipeline.js';
import {
  type PreFetchCoordinatorDependencies,
  preFetchNestedRecordsBeforeOperation,
} from './lifecycle/pre-fetch/coordinator.js';
import {
  createBuildLogsStage,
  createEnrichContextsStage,
  createExecuteOperationStage,
  createFetchBeforeStateStage,
  type StageDependencies,
} from './lifecycle/stages.js';
import { createTransactionProxy } from './lifecycle/transaction-proxy.js';
import { withOptionalTransaction } from './lifecycle/transaction-wrapper.js';
import type { BatchFinalContext, BatchInitialContext, BeforeStateResult } from './lifecycle/types.js';
import type {
  AuditErrorContext,
  AuditLogData,
  OperationContext,
  PrismaAction,
  PrismaAuditExtensionOptions,
  WriteFailurePolicy,
} from './types.js';
import {
  buildEntityMap,
  ensureIds,
  extractPrimaryKey,
  findManyByPKs,
  getModelAccessor,
  getPrimaryKeyFields,
  getPrisma,
  injectDeepInclude,
  isAuditableAction,
  isBatchOperation,
  isCallerMutationError,
  requiresBeforeState,
  runCallerMutation,
  shouldAuditModel,
  uncapitalizeFirst,
} from './utils/index.js';

/**
 * Input for the `handleLimitedUpdateMany` helper defined inside {@link createAuditLogExtension}.
 */
interface HandleLimitedUpdateManyInput {
  operation: OperationContext;
  context: AuditContext;
  baseClient: PrismaClientWithDynamicAccess;
  clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  action: PrismaAction;
  modelDelegate: {
    findMany: (args: { where: unknown }) => Promise<Record<string, unknown>[]>;
    updateManyAndReturn: (args: unknown) => Promise<Record<string, unknown>[]>;
  };
  pkFields: string[];
  whereClause: unknown;
}

/**
 * A batch-dispatch path's output: the caller's operation result and the audit logs built
 * for it, unwritten — `executeBatch` writes `logs` outside its try/catch.
 */
interface BatchActionResult {
  result: unknown;
  logs: AuditLogData[];
}

/**
 * Creates the Prisma Client Extension for automatic audit logging
 *
 * @remarks
 * Internal extension factory, not exported from the package entry: `createAuditClient`
 * applies it via `prisma.$extends()` and returns the typed client.
 *
 * @returns Prisma Client Extension definition (use with `prisma.$extends()`)
 * @throws {Error} If configuration contains conflicts or peer dependency missing
 */
export const createAuditLogExtension = (options: PrismaAuditExtensionOptions) => {
  const {
    provider,
    basePrisma,
    aggregateMapping,
    diffing,
    security,
    performance,
    hooks,
    contextEnricher,
    auditLogModel: customAuditLogModel,
    Prisma: userProvidedPrisma,
    errorHandling,
  } = options;

  // Use user-provided Prisma namespace or extract from basePrisma
  // User-provided is required for Prisma 6.x+ with custom output paths
  const Prisma = (userProvidedPrisma ?? getPrisma(basePrisma as PrismaClientWithDynamicAccess)) as PrismaNamespace;
  const DbNull = Prisma.DbNull;
  const auditLogModel = customAuditLogModel ? uncapitalizeFirst(customAuditLogModel) : 'auditLog';
  const excludeFields = diffing?.excludeFields ?? [];
  const redact = security?.redact;
  const serialization = options.serialization;
  const sampling = performance?.sampling ?? 1.0;
  const awaitWrite = performance?.awaitWrite ?? true;
  const awaitWriteIf = performance?.awaitWriteIf;
  const samplingIf = performance?.samplingIf;
  const writer = hooks?.writer;
  const observer = errorHandling?.observer;
  // An audit library must not break the caller's write by default.
  const writeFailurePolicyConfig: WriteFailurePolicy = errorHandling?.writeFailurePolicy ?? 'log';

  const aggregateConfig = createAggregateConfig(aggregateMapping);
  const writeExecutor = createPrismaWriteExecutor(DbNull);
  const strategySelector = createWriteStrategySelector(
    {
      awaitWrite,
      awaitWriteIf,
      aggregateConfig,
    },
    writeExecutor,
  );

  /**
   * Notifies the observer of an audit failure. An observer that throws (sync or async) is
   * logged to the console and ignored, so it never affects the caller's own database operation.
   */
  const notifyObserver = async (context: AuditErrorContext): Promise<void> => {
    if (!observer) return;
    try {
      await observer(context);
    } catch (observerError) {
      console.error(
        '[@prisma-audit] Error in error-handling observer:',
        observerError instanceof Error ? observerError.message : String(observerError),
      );
    }
  };

  /**
   * Resolves and applies the write-failure policy for a single `log-write` failure:
   * 'throw' re-throws (failing the caller's operation only while it is still waiting on the
   * write — see {@link WriteFailurePolicy}), 'log' logs to the console, 'ignore' does neither.
   *
   * A policy function that throws falls back to `'log'`: unlike `'throw'` it cannot fail the
   * caller's operation, and unlike `'ignore'` it still surfaces the `log-write` failure.
   */
  const applyWriteFailurePolicy = async (context: AuditErrorContext, logLabel: string): Promise<void> => {
    let strategy: ErrorStrategy;
    if (typeof writeFailurePolicyConfig === 'function') {
      try {
        strategy = await writeFailurePolicyConfig(context);
      } catch (policyError) {
        console.error(
          "[@prisma-audit] Error in writeFailurePolicy function; falling back to 'log':",
          policyError instanceof Error ? policyError.message : String(policyError),
        );
        strategy = 'log';
      }
    } else {
      strategy = writeFailurePolicyConfig;
    }
    createErrorHandler(strategy)(context.error, logLabel);
  };

  /**
   * Only {@link writeAuditLogs} calls this. Every other phase (`pre-fetch`, `diff-generation`,
   * `entity-id-resolution`) calls `notifyObserver` directly, which is what keeps
   * {@link WriteFailurePolicy}'s "only `log-write` is policy-gated" contract true.
   */
  const reportWriteFailure = async (context: AuditErrorContext, logLabel: string): Promise<void> => {
    await notifyObserver(context);
    await applyWriteFailurePolicy(context, logLabel);
  };

  validateFieldConflicts(excludeFields, redact, aggregateMapping);

  const shouldAudit = (modelName: string | undefined, context: AuditContext | undefined): boolean => {
    return shouldAuditModel({
      modelName,
      context,
      auditLogModel,
      isLoggable: aggregateConfig.isLoggable,
      sampling,
      samplingIf,
      getEntityConfig: aggregateConfig.getEntityConfig,
    });
  };

  const getNestedOperationConfigWrapper = (modelName: string, operation: string): { fetchBeforeOperation: boolean } => {
    return getNestedOperationConfig(modelName, operation, {
      getEntityConfig: aggregateConfig.getEntityConfig,
      globalNestedOperations: options.nestedOperations,
    });
  };

  const handleWriteResult = (result: WriteResult): void => {
    if (result._tag === 'Skipped' && process.env.DEBUG_AUDIT_WRITE) {
      console.warn(`[@prisma-audit] Skipped audit write: ${result.reason}`);
    }
  };

  /**
   * Writes audit logs via the configured write strategy.
   *
   * @remarks
   * A write failure of the synchronous strategy (the `awaitWrite: true` default) surfaces in
   * the `catch` below, since that strategy has no error handling of its own. The deferred and
   * fire-and-forget strategies call `writeErrorHandler` themselves after the write was queued
   * or detached, and catch and log anything it throws, so a `'throw'` policy cannot become an
   * unhandled rejection (see {@link WriteFailurePolicy}).
   */
  const writeAuditLogs = async (logs: AuditLogData[], baseClient: PrismaClientWithDynamicAccess): Promise<void> => {
    if (logs.length === 0) {
      return;
    }

    try {
      const context = provider.getContext();
      if (!context) {
        return;
      }

      const modelName = logs[0]?.entityType;
      if (!modelName) {
        return;
      }

      const manager = createPrismaClientManager(baseClient);
      const strategy = strategySelector(modelName);

      const writeErrorHandler = async (error: Error, operationDescription: string): Promise<void> => {
        await reportWriteFailure(
          { phase: 'log-write', modelName, operation: 'write', params: logs, error },
          operationDescription,
        );
      };

      const result = await strategy({
        logs,
        context,
        manager,
        auditLogModel,
        writer,
        handleError: writeErrorHandler,
      });

      handleWriteResult(result);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      const modelName = logs[0]?.entityType ?? 'unknown';
      await reportWriteFailure(
        { phase: 'log-write', modelName, operation: 'write', params: logs, error },
        'audit log write',
      );
    }
  };

  const hasFindUnique = (value: unknown): value is { findUnique: (args: { where: unknown }) => Promise<unknown> } => {
    return (
      typeof value === 'object' &&
      value !== null &&
      'findUnique' in value &&
      typeof (value as { findUnique: unknown }).findUnique === 'function'
    );
  };

  const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  };

  const executeFallbackAction = async (
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    operation: OperationContext,
  ): Promise<unknown> => {
    const modelAccessor = getModelAccessor(clientToUse, modelName);
    const delegate = clientToUse[modelAccessor] as Record<string, unknown>;
    const actionFn = delegate[operation.action as string] as (args: unknown) => Promise<unknown>;
    // No audit-support work runs here, so any failure is the caller's own; the tag lets
    // `executeBatch` rethrow it untouched instead of reporting it as `diff-generation`.
    return runCallerMutation(() => actionFn(operation.args));
  };

  const findExistingRecord = async (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    where: unknown,
  ): Promise<BeforeStateResult> => {
    const modelAccessor = getModelAccessor(prismaClient, modelName);
    const modelClient = prismaClient[modelAccessor];

    if (!hasFindUnique(modelClient)) {
      return { _tag: 'notFound' };
    }

    const result = await modelClient.findUnique({ where });
    return isRecord(result) ? { _tag: 'found', data: result } : { _tag: 'notFound' };
  };

  const fetchBeforeState = async (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    action: PrismaAction,
    args: Record<string, unknown>,
  ): Promise<BeforeStateResult> => {
    // `requiresBeforeState` also lists the batch actions, which cannot reach this
    // findUnique-based path: `$allOperations` routes them to handleBatchOperation,
    // which captures their before-state with findMany instead.
    if (!requiresBeforeState(action) || !args.where) {
      return { _tag: 'notFound' };
    }

    try {
      return await findExistingRecord(prismaClient, modelName, args.where);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      await notifyObserver({ phase: 'pre-fetch', modelName, operation: action, params: args, error });
      return { _tag: 'error', error };
    }
  };

  /**
   * Pre-fetch nested records before operation execution
   * @returns Path-based Map: path → record | null
   */
  const preFetchNestedRecordsBeforeOperationWrapper = async (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    args: Record<string, unknown>,
  ): Promise<PreFetchResults> => {
    const dependencies: PreFetchCoordinatorDependencies = {
      Prisma,
      getNestedOperationConfig: getNestedOperationConfigWrapper,
      onPreFetchFailure: notifyObserver,
    };

    return preFetchNestedRecordsBeforeOperation(prismaClient, modelName, args, dependencies);
  };

  const createStageDependencies = (baseClient: PrismaClientWithDynamicAccess): StageDependencies => ({
    fetchBeforeState,
    preFetchNestedRecordsBeforeOperation: preFetchNestedRecordsBeforeOperationWrapper,
    getNestedOperationConfig: getNestedOperationConfigWrapper,
    enrichActorContext,
    batchEnrichEntityContexts: (entities, config, prisma) => {
      return batchEnrichEntityContexts(entities, config, prisma);
    },
    buildAuditLog,
    buildNestedAuditLogs: (params: BuildNestedAuditLogsParams) =>
      buildNestedAuditLogs({
        ...params,
        deps: {
          aggregateConfig,
          excludeFields,
          redact,
          serialization,
          basePrisma: baseClient,
          getNestedOperationConfig: getNestedOperationConfigWrapper,
          Prisma,
          // A nested delete whose primary key cannot be resolved is skipped rather than
          // recorded under a partial or fabricated identity (see collectDeleteRecords). It is
          // reported under its own phase: the record's identity is what failed, not a
          // pre-fetch or diff generation.
          onUnresolvedDeleteEntityId: async ({ relatedModel, entityId, pkFields, error }) => {
            await notifyObserver({
              phase: 'entity-id-resolution',
              modelName: relatedModel,
              operation: 'delete',
              params: { entityId, pkFields },
              error,
            });
          },
        },
      }),
    aggregateConfig,
    excludeFields,
    redact,
    serialization,
    basePrisma: baseClient,
    contextEnricher,
  });

  const createLifecycleStages = (baseClient: PrismaClientWithDynamicAccess) => {
    const stageDependencies = createStageDependencies(baseClient);
    return [
      createFetchBeforeStateStage(stageDependencies),
      createExecuteOperationStage(),
      createEnrichContextsStage(stageDependencies),
      createBuildLogsStage(stageDependencies),
    ] as const;
  };

  const handleSingleOperation = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
    query: (args: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const lifecycleStages = createLifecycleStages(baseClient);

    const handlerDeps: TopLevelHandlerDependencies = {
      lifecycleStages: lifecycleStages as unknown as ReadonlyArray<(context: unknown) => Promise<unknown>>,
      writeAuditLogs,
      basePrisma: baseClient,
      aggregateConfig,
      provider,
      awaitWrite,
      awaitWriteIf,
      // `executeAuditedOperation` (operation-executor.ts) rethrows the caller's own mutation
      // error (see `isCallerMutationError`) before calling this, so only audit-stage failures
      // (fetch-before-state / enrich / build) reach the observer here.
      onPipelineError: async (error: Error) => {
        const modelName = operation.model ?? 'unknown';
        await notifyObserver({
          phase: 'diff-generation',
          modelName,
          operation: operation.action as string,
          params: operation.args,
          error,
        });
      },
    };

    return handleTopLevelOperation(operation, context, baseClient, query, handlerDeps);
  };

  const hasFindMany = (
    value: unknown,
  ): value is {
    findMany: (args: { where: unknown }) => Promise<Record<string, unknown>[]>;
  } => {
    return (
      typeof value === 'object' &&
      value !== null &&
      'findMany' in value &&
      typeof (value as { findMany: unknown }).findMany === 'function'
    );
  };

  // `updateManyAndReturn` is unavailable on connectors like MySQL. When present, we can
  // pin the audited rows to the ones the database actually updated under `limit`.
  const hasUpdateManyAndReturn = (
    value: unknown,
  ): value is {
    updateManyAndReturn: (args: unknown) => Promise<Record<string, unknown>[]>;
  } => {
    return (
      typeof value === 'object' &&
      value !== null &&
      'updateManyAndReturn' in value &&
      typeof (value as { updateManyAndReturn: unknown }).updateManyAndReturn === 'function'
    );
  };

  /**
   * Runs the batch enrich/build stages and returns the resulting audit logs unwritten;
   * `executeBatch` writes them outside its try/catch (see the note above `executeBatch`).
   */
  const runBatchPipeline = async (
    batchInitialContext: BatchInitialContext,
    baseClient: PrismaClientWithDynamicAccess,
  ): Promise<AuditLogData[]> => {
    const stageDependencies = createStageDependencies(baseClient);
    const batchStages = [
      createBatchEnrichContextsStage(stageDependencies),
      createBatchBuildLogsStage(stageDependencies),
    ] as const;

    const batchFinalContext = await runLifecyclePipeline<BatchInitialContext, BatchFinalContext>(
      batchInitialContext,
      batchStages,
    );

    return [...batchFinalContext.logs];
  };

  const handleCreateMany = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  ): Promise<BatchActionResult> => {
    const modelName = operation.model as string;
    const args = operation.args as { data: unknown; select?: unknown; omit?: unknown };

    const modelAccessor = getModelAccessor(clientToUse, modelName);
    const delegate = clientToUse[modelAccessor] as Record<string, unknown>;
    // Call the real action so createManyAndReturn keeps returning the row array (not {count})
    const actionName = operation.action as string;
    const createFn = delegate[actionName] as (args: unknown) => Promise<unknown>;

    let result: unknown;
    let entities: Record<string, unknown>[];

    if (actionName === AUDIT_ACTION.CREATE_MANY_AND_RETURN && args.select == null && args.omit == null) {
      // Rely entirely on Prisma's own ID generation and audit the rows it
      // actually created. This supports database-generated defaults
      // (autoincrement, dbgenerated) and stays correct under skipDuplicates.
      result = await runCallerMutation(() => createFn(operation.args));
      entities = (Array.isArray(result) ? result : []) as Record<string, unknown>[];
    } else {
      // createMany returns only { count }, and select/omit narrow returned rows
      // below what aggregate resolvers may need — both leave client-side ID
      // injection as the only way for audit logs to record the created IDs.
      // Normalize single-object data to an array so `data: {...}` is logged like `data: [...]`
      const rawData = args.data;
      const dataArray = Array.isArray(rawData) ? rawData : [rawData as Record<string, unknown>];
      entities = ensureIds(Prisma, modelName, dataArray, DEFAULTS.ID_FIELD);
      result = await runCallerMutation(() => createFn({ ...operation.args, data: entities }));
    }

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      entities,
    };

    const logs = await runBatchPipeline(batchInitialContext, baseClient);
    return { result, logs };
  };

  // Resolve and validate the model delegate used by batch update/delete handling.
  const resolveBatchModelDelegate = (
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
  ): { findMany: (args: { where: unknown }) => Promise<Record<string, unknown>[]> } => {
    const entityConfig = aggregateConfig.getEntityConfig(modelName);
    if (!entityConfig) {
      throw new Error(
        `No entity configuration found for model: ${modelName}. ` +
          `Batch operations require entity configuration to be defined.`,
      );
    }

    const modelAccessor = getModelAccessor(clientToUse, modelName);
    const modelDelegate = clientToUse[modelAccessor];

    if (!hasFindMany(modelDelegate)) {
      throw new Error(`Model ${modelName} does not have findMany operation. This is required for batch operations.`);
    }

    return modelDelegate;
  };

  // Pair each after-row with its before-state by primary key.
  const pairEntitiesByPrimaryKey = (
    afterEntities: Record<string, unknown>[],
    beforeEntities: Record<string, unknown>[],
    pkFields: string[],
  ): {
    entities: Record<string, unknown>[];
    pairedBeforeStates: Array<Record<string, unknown> | null>;
  } => {
    const beforeMap = buildEntityMap(beforeEntities, pkFields);
    return {
      entities: afterEntities,
      pairedBeforeStates: afterEntities.map((entity) => beforeMap.get(extractPrimaryKey(entity, pkFields)) ?? null),
    };
  };

  // Re-fetch updated rows by PK (not original WHERE) to handle WHERE-field mutations,
  // pairing each after-state with its before-state.
  const pairUpdatedEntitiesWithBefore = async (
    modelDelegate: { findMany: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown>[]> },
    beforeEntities: Record<string, unknown>[],
    pkFields: string[],
  ): Promise<{
    entities: Record<string, unknown>[];
    pairedBeforeStates: Array<Record<string, unknown> | null>;
  }> => {
    const afterEntities = await findManyByPKs(modelDelegate, pkFields, beforeEntities);
    return pairEntitiesByPrimaryKey(afterEntities, beforeEntities, pkFields);
  };

  // Audit a `limit`-bounded update by routing it through `updateManyAndReturn`, whose return value
  // is the exact set of updated rows. This pins before/after to those rows and avoids the count
  // desync a separately-limited before fetch allows. Only used when the connector supports
  // updateManyAndReturn (see caller guard).
  const handleLimitedUpdateMany = async (input: HandleLimitedUpdateManyInput): Promise<BatchActionResult> => {
    const { operation, context, baseClient, clientToUse, action, modelDelegate, pkFields, whereClause } = input;

    const beforeEntities = await modelDelegate.findMany({ where: whereClause || {} });
    const updatedRows = await runCallerMutation(() => modelDelegate.updateManyAndReturn(operation.args));
    const paired = pairEntitiesByPrimaryKey(updatedRows, beforeEntities, pkFields);

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      entities: paired.entities,
      beforeStates: paired.pairedBeforeStates,
    };
    const logs = await runBatchPipeline(batchInitialContext, baseClient);

    // Preserve each action's contract: updateMany returns { count }, updateManyAndReturn the rows.
    const result = action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN ? updatedRows : { count: updatedRows.length };
    return { result, logs };
  };

  const handleUpdateOrDeleteMany = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    action: PrismaAction,
  ): Promise<BatchActionResult> => {
    const modelName = operation.model as string;
    const modelDelegate = resolveBatchModelDelegate(clientToUse, modelName);

    const pkFields = getPrimaryKeyFields(Prisma, modelName);

    const args = isRecord(operation.args) ? operation.args : {};
    const whereClause = args.where;
    const limitClause = typeof args.limit === 'number' ? args.limit : undefined;

    const isUpdate = action === AUDIT_ACTION.UPDATE_MANY || action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN;

    // `updateMany({ limit })` and a separate `findMany({ take })` are not guaranteed to select the
    // same rows, so pre-limiting the before fetch desyncs before/after counts. When the
    // connector supports `updateManyAndReturn`, audit through it for exact-row fidelity. MySQL and
    // other connectors without it fall through to the best-effort `take: limit` path below.
    if (isUpdate && limitClause !== undefined && hasUpdateManyAndReturn(modelDelegate)) {
      return handleLimitedUpdateMany({
        operation,
        context,
        baseClient,
        clientToUse,
        action,
        modelDelegate: modelDelegate as HandleLimitedUpdateManyInput['modelDelegate'],
        pkFields,
        whereClause,
      });
    }

    // Propagate `limit` to the before fetch so before/after counts match the actually-updated rows
    // on connectors without updateManyAndReturn (best-effort; exact row match is not guaranteed).
    const beforeEntities = await modelDelegate.findMany({
      where: whereClause || {},
      ...(limitClause !== undefined ? { take: limitClause } : {}),
    });

    // Execute mutation via model delegate (not query()) so it participates in the transaction.
    // Use the real action name so updateManyAndReturn is not misrouted to deleteMany.
    const delegate = modelDelegate as unknown as Record<string, unknown>;
    const actionName = operation.action as string;
    const mutationFn = delegate[actionName] as (args: unknown) => Promise<unknown>;
    const result = await runCallerMutation(() => mutationFn(operation.args));

    let entities: Record<string, unknown>[];
    let pairedBeforeStates: Array<Record<string, unknown> | null>;

    if (isUpdate && beforeEntities.length > 0) {
      const paired = await pairUpdatedEntitiesWithBefore(
        modelDelegate as { findMany: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown>[]> },
        beforeEntities,
        pkFields,
      );
      entities = paired.entities;
      pairedBeforeStates = paired.pairedBeforeStates;
    } else {
      // deleteMany: before = entities (no after state)
      entities = beforeEntities;
      pairedBeforeStates = beforeEntities.map((e) => e);
    }

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      entities,
      beforeStates: pairedBeforeStates,
    };

    const logs = await runBatchPipeline(batchInitialContext, baseClient);
    return { result, logs };
  };

  const handleBatchOperation = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
  ): Promise<unknown> => {
    const modelName = operation.model as string;
    const entityConfig = modelName ? aggregateConfig.getEntityConfig(modelName) : undefined;
    const shouldAwaitForModel =
      awaitWriteIf && entityConfig?.tags && modelName ? awaitWriteIf(modelName, entityConfig.tags) : awaitWrite;

    const dispatchBatchAction = async (
      txContext: AuditContext,
      clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    ): Promise<BatchActionResult> => {
      const action = operation.action as PrismaAction;

      if (action === AUDIT_ACTION.CREATE_MANY || action === AUDIT_ACTION.CREATE_MANY_AND_RETURN) {
        return handleCreateMany(operation, txContext, baseClient, clientToUse);
      }

      if (
        (action === AUDIT_ACTION.UPDATE_MANY ||
          action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN ||
          action === AUDIT_ACTION.DELETE_MANY) &&
        operation.model
      ) {
        return handleUpdateOrDeleteMany(operation, txContext, baseClient, clientToUse, action);
      }

      const result = await executeFallbackAction(clientToUse, modelName, operation);
      return { result, logs: [] };
    };

    // `dispatchBatchAction` runs audit-support work (before-fetch, after-refetch,
    // enrich/build) around the caller's own mutation and returns the logs it builds
    // unwritten, as `executeAuditedOperation` (operation-executor.ts) does. `writeAuditLogs`
    // must stay outside this try/catch: it reports `log-write` failures itself, and a
    // `'throw'` policy's rethrow would otherwise be re-reported here as `diff-generation`.
    const executeBatch = async (
      txContext: AuditContext,
      clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    ): Promise<unknown> => {
      let dispatchResult: BatchActionResult;
      try {
        dispatchResult = await dispatchBatchAction(txContext, clientToUse);
      } catch (caughtError) {
        if (isCallerMutationError(caughtError)) {
          // The caller's own database operation failed on its own terms (e.g. a unique
          // constraint violation) — not an audit failure. Propagate it untouched,
          // without routing it through the audit observer or policy.
          throw caughtError;
        }

        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
        // Observer-only, like `executeAuditedOperation`'s `onPipelineError`: a `diff-generation`
        // failure always propagates to the caller, so `writeFailurePolicy` has nothing to decide.
        await notifyObserver({
          phase: 'diff-generation',
          modelName,
          operation: operation.action as string,
          params: operation.args,
          error,
        });
        throw error;
      }

      await writeAuditLogs(dispatchResult.logs, baseClient);
      return dispatchResult.result;
    };

    const wrapper = withOptionalTransaction(
      { shouldWrap: shouldAwaitForModel, context, basePrisma: baseClient },
      provider,
    );

    return wrapper(executeBatch);
  };

  const extensionDefinition = (baseClient: PrismaClientWithDynamicAccess) => {
    const extendedClient = baseClient.$extends({
      name: 'prisma-audit',
      query: {
        $allModels: {
          async $allOperations(params: ExtensionParams) {
            const { operation, model, args, query } = params;

            const context = provider.getContext();

            if (getRuntimeContext()?.isProcessingAuditLog) {
              return query(args);
            }

            if (!model || !shouldAudit(model, context)) {
              return query(args);
            }

            if (!isAuditableAction(operation)) {
              return query(args);
            }

            // Inject deep include for nested write operations (3+ levels)
            const argsWithInclude = injectDeepInclude(args);

            // Mark the re-entrancy guard on the library-owned runtime store; the app context
            // stays untouched so downstream code keeps the caller's actor and request metadata.
            return runWithRuntimeContext({ isProcessingAuditLog: true }, async () => {
              const operationContext: OperationContext = {
                model,
                action: operation,
                args: argsWithInclude as Record<string, unknown>,
              };

              if (isBatchOperation(operation)) {
                return handleBatchOperation(operationContext, context as AuditContext, baseClient);
              }

              return handleSingleOperation(operationContext, context as AuditContext, baseClient, (modifiedArgs) =>
                query(modifiedArgs ?? argsWithInclude),
              );
            });
          },
        },
      },
    });

    return createTransactionProxy(extendedClient as object, provider);
  };

  return Prisma.defineExtension(extensionDefinition);
};
