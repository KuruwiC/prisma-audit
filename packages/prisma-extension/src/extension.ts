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

import type { AuditContext, PreFetchResults } from '@kuruwic/prisma-audit-core';
import {
  AUDIT_ACTION,
  batchEnrichAggregateContexts,
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
import { buildNestedAuditLogs } from './lifecycle/nested-handlers/index.js';
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
import type { AuditLogData, OperationContext, PrismaAction, PrismaAuditExtensionOptions } from './types.js';
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
  shouldAuditModel,
  uncapitalizeFirst,
} from './utils/index.js';

/**
 * Creates the Prisma Client Extension for automatic audit logging
 *
 * @returns Prisma Client Extension definition (use with `prisma.$extends()`)
 * @throws {Error} If configuration contains conflicts or peer dependency missing
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 * import { createAuditLogExtension } from '@kuruwic/prisma-audit';
 *
 * const extension = createAuditLogExtension({
 *   provider: auditContextProvider,
 *   basePrisma: new PrismaClient(),
 *   aggregateMapping: { ... },
 * });
 *
 * const prisma = basePrisma.$extends(extension);
 * ```
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
    onAuditErrorHandler,
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
  const errorHandlerConfig = hooks?.errorHandler ?? 'log';

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

  const handleError =
    typeof errorHandlerConfig === 'function' ? errorHandlerConfig : createErrorHandler(errorHandlerConfig);

  const dispatchAuditError = async (
    phase: 'pre-fetch' | 'log-write' | 'diff-generation',
    modelName: string,
    operation: string,
    params: unknown,
    error: Error,
  ): Promise<void> => {
    if (onAuditErrorHandler) {
      await onAuditErrorHandler({ phase, modelName, operation, params, error });
    }
  };

  validateFieldConflicts(excludeFields, redact, aggregateMapping);

  const shouldAudit = (modelName: string | undefined, context: AuditContext | undefined): boolean => {
    return shouldAuditModel(
      modelName,
      context,
      auditLogModel,
      aggregateConfig.isLoggable,
      sampling,
      samplingIf,
      aggregateConfig.getEntityConfig,
    );
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
      const strategy = strategySelector(context, modelName);

      const writeErrorHandler: typeof handleError = async (error, errorContext) => {
        await dispatchAuditError('log-write', modelName, 'write', logs, error);
        await handleError(error, errorContext);
      };

      const result = await strategy(logs, context, manager, auditLogModel, writer, writeErrorHandler, writeExecutor);

      handleWriteResult(result);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      const modelName = logs[0]?.entityType ?? 'unknown';
      await dispatchAuditError('log-write', modelName, 'write', logs, error);
      await handleError(error, 'audit log write');
      throw error;
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
    return actionFn(operation.args);
  };

  const requiresBeforeState = (action: PrismaAction): boolean =>
    action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE || action === AUDIT_ACTION.UPSERT;

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
    if (!requiresBeforeState(action) || !args.where) {
      return { _tag: 'notFound' };
    }

    try {
      return await findExistingRecord(prismaClient, modelName, args.where);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      await dispatchAuditError('pre-fetch', modelName, action, args, error);
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
    };

    return preFetchNestedRecordsBeforeOperation(prismaClient, modelName, args, dependencies);
  };

  const createStageDependencies = (baseClient: PrismaClientWithDynamicAccess): StageDependencies => ({
    fetchBeforeState,
    preFetchNestedRecordsBeforeOperation: preFetchNestedRecordsBeforeOperationWrapper,
    getNestedOperationConfig: getNestedOperationConfigWrapper,
    enrichActorContext,
    batchEnrichEntityContexts: (entities, config, prisma, meta) => {
      return batchEnrichEntityContexts(entities, config, prisma, meta);
    },
    batchEnrichAggregateContexts: (entities, config, prisma, meta) => {
      return batchEnrichAggregateContexts(entities, config, prisma, meta);
    },
    buildAuditLog,
    buildNestedAuditLogs: (
      modelName: string,
      args: Record<string, unknown>,
      result: unknown,
      context: AuditContext,
      prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
      actorContext: unknown,
      preFetchResults?: PreFetchResults,
    ) =>
      buildNestedAuditLogs(modelName, args, result, context, prismaClient, actorContext, preFetchResults, {
        aggregateConfig,
        excludeFields,
        redact,
        serialization,
        basePrisma: baseClient,
        getNestedOperationConfig: getNestedOperationConfigWrapper,
        Prisma,
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
      onPipelineError: async (error: Error) => {
        const modelName = operation.model ?? 'unknown';
        await dispatchAuditError('diff-generation', modelName, operation.action as string, operation.args, error);
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
  // pin the audited rows to the ones the database actually updated under `limit` (debt #2).
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

  const runBatchPipeline = async (
    batchInitialContext: BatchInitialContext,
    baseClient: PrismaClientWithDynamicAccess,
  ): Promise<void> => {
    const stageDependencies = createStageDependencies(baseClient);
    const batchStages = [
      createBatchEnrichContextsStage(stageDependencies),
      createBatchBuildLogsStage(stageDependencies),
    ] as const;

    const batchFinalContext = await runLifecyclePipeline<BatchInitialContext, BatchFinalContext>(
      batchInitialContext,
      batchStages,
    );

    await writeAuditLogs([...batchFinalContext.logs], baseClient);
  };

  const handleCreateMany = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  ): Promise<unknown> => {
    const modelName = operation.model as string;

    // Normalize single-object data to an array so `data: {...}` is logged like `data: [...]` (debt #1)
    const rawData = (operation.args as { data: unknown }).data;
    const dataArray = Array.isArray(rawData) ? rawData : [rawData as Record<string, unknown>];
    const dataWithIds = ensureIds(Prisma, modelName, dataArray, DEFAULTS.ID_FIELD);

    const argsWithIds = {
      ...operation.args,
      data: dataWithIds,
    };

    const modelAccessor = getModelAccessor(clientToUse, modelName);
    const delegate = clientToUse[modelAccessor] as Record<string, unknown>;
    // Call the real action so createManyAndReturn keeps returning the row array (not {count})
    const actionName = operation.action as string;
    const createFn = delegate[actionName] as (args: unknown) => Promise<unknown>;
    const result = await createFn(argsWithIds);

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      query: createFn,
      entities: dataWithIds,
    };

    await runBatchPipeline(batchInitialContext, baseClient);
    return result;
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
  // is the exact set of updated rows. This pins before/after to those rows and sidesteps debt #2's
  // count desync. Only used when the connector supports updateManyAndReturn (see caller guard).
  const handleLimitedUpdateMany = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    action: PrismaAction,
    modelDelegate: {
      findMany: (args: { where: unknown }) => Promise<Record<string, unknown>[]>;
      updateManyAndReturn: (args: unknown) => Promise<Record<string, unknown>[]>;
    },
    pkFields: string[],
    whereClause: unknown,
  ): Promise<unknown> => {
    const beforeEntities = await modelDelegate.findMany({ where: whereClause || {} });
    const updatedRows = await modelDelegate.updateManyAndReturn(operation.args);
    const paired = pairEntitiesByPrimaryKey(updatedRows, beforeEntities, pkFields);

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      query: modelDelegate.updateManyAndReturn as (args: unknown) => Promise<unknown>,
      entities: paired.entities,
      beforeStates: paired.pairedBeforeStates,
    };
    await runBatchPipeline(batchInitialContext, baseClient);

    // Preserve each action's contract: updateMany returns { count }, updateManyAndReturn the rows.
    return action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN ? updatedRows : { count: updatedRows.length };
  };

  const handleUpdateOrDeleteMany = async (
    operation: OperationContext,
    context: AuditContext,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    action: PrismaAction,
  ): Promise<unknown> => {
    const modelName = operation.model as string;
    const modelDelegate = resolveBatchModelDelegate(clientToUse, modelName);

    const pkFields = getPrimaryKeyFields(Prisma, modelName);

    const args = isRecord(operation.args) ? operation.args : {};
    const whereClause = args.where;
    const limitClause = typeof args.limit === 'number' ? args.limit : undefined;

    const isUpdate = action === AUDIT_ACTION.UPDATE_MANY || action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN;

    // `updateMany({ limit })` and a separate `findMany({ take })` are not guaranteed to select the
    // same rows, so pre-limiting the before fetch desyncs before/after counts (debt #2). When the
    // connector supports `updateManyAndReturn`, audit through it for exact-row fidelity. MySQL and
    // other connectors without it fall through to the best-effort `take: limit` path below.
    if (isUpdate && limitClause !== undefined && hasUpdateManyAndReturn(modelDelegate)) {
      return handleLimitedUpdateMany(
        operation,
        context,
        baseClient,
        clientToUse,
        action,
        modelDelegate as typeof modelDelegate & {
          updateManyAndReturn: (args: unknown) => Promise<Record<string, unknown>[]>;
        },
        pkFields,
        whereClause,
      );
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
    const result = await mutationFn(operation.args);

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
      query: mutationFn,
      entities,
      beforeStates: pairedBeforeStates,
    };

    await runBatchPipeline(batchInitialContext, baseClient);
    return result;
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
    ): Promise<unknown> => {
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

      return executeFallbackAction(clientToUse, modelName, operation);
    };

    const executeBatch = async (
      txContext: AuditContext,
      clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    ): Promise<unknown> => {
      try {
        return await dispatchBatchAction(txContext, clientToUse);
      } catch (caughtError) {
        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
        await handleError(error, `batch operation: ${operation.action}`);
        throw error;
      }
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
