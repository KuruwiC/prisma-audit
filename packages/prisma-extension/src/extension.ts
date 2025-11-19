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
  batchEnrichEntityContexts,
  createAggregateConfig,
  createErrorHandler,
  createWriteStrategySelector,
  DEFAULTS,
  enrichActorContext,
  type WriteResult,
} from '@kuruwic/prisma-audit-core';
import { createPrismaWriteExecutor } from './adapters/write-executor.js';
import { buildAuditLog } from './audit-log-builder/index.js';
import { createPrismaClientManager } from './client-manager/index.js';
import { getNestedOperationConfig, validateFieldConflicts } from './config/index.js';
import type { ExtensionParams, PrismaClientWithDynamicAccess, TransactionalPrismaClient } from './internal-types.js';
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
import type { BatchFinalContext, BatchInitialContext } from './lifecycle/types.js';
import type { AuditLogData, OperationContext, PrismaAction, PrismaAuditExtensionOptions } from './types.js';
import {
  ensureIds,
  getModelAccessor,
  getPrisma,
  injectDeepInclude,
  isAuditableAction,
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
    DbNull: userProvidedDbNull,
  } = options;

  const DbNull = userProvidedDbNull ?? getPrisma(basePrisma as PrismaClientWithDynamicAccess).DbNull;
  const auditLogModel = customAuditLogModel ? uncapitalizeFirst(customAuditLogModel) : 'auditLog';
  const excludeFields = diffing?.excludeFields ?? [];
  const redact = security?.redact;
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

      const manager = createPrismaClientManager(baseClient, context);
      const strategy = strategySelector(context, modelName);
      const result = await strategy(logs, context, manager, auditLogModel, writer, handleError, writeExecutor);

      handleWriteResult(result);
    } catch (error) {
      handleError(error instanceof Error ? error : new Error(String(error)), 'audit log write');
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

  const fetchBeforeState = async (
    prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    modelName: string,
    action: PrismaAction,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    if (
      (action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE || action === AUDIT_ACTION.UPSERT) &&
      args.where
    ) {
      try {
        const modelAccessor = getModelAccessor(prismaClient, modelName);
        const modelClient = prismaClient[modelAccessor];

        if (hasFindUnique(modelClient)) {
          const result = await modelClient.findUnique({ where: args.where });
          return isRecord(result) ? result : null;
        }
      } catch {
        return null;
      }
    }
    return null;
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
      getPrisma,
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
        basePrisma: baseClient,
        getNestedOperationConfig: getNestedOperationConfigWrapper,
        getPrisma,
      }),
    aggregateConfig,
    excludeFields,
    redact,
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
    query: (args: unknown) => Promise<unknown>,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  ): Promise<unknown> => {
    const dataWithIds = ensureIds(
      getPrisma(),
      operation.model as string,
      (operation.args as { data: Record<string, unknown>[] }).data,
      DEFAULTS.ID_FIELD,
    );

    const argsWithIds = {
      ...operation.args,
      data: dataWithIds,
    };

    const result = await query(argsWithIds);

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      query,
      entities: dataWithIds,
    };

    await runBatchPipeline(batchInitialContext, baseClient);
    return result;
  };

  const handleUpdateOrDeleteMany = async (
    operation: OperationContext,
    context: AuditContext,
    query: (args: unknown) => Promise<unknown>,
    baseClient: PrismaClientWithDynamicAccess,
    clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
    action: PrismaAction,
  ): Promise<unknown> => {
    const entityConfig = aggregateConfig.getEntityConfig(operation.model as string);
    if (!entityConfig) {
      throw new Error(
        `No entity configuration found for model: ${operation.model}. ` +
          `Batch operations require entity configuration to be defined.`,
      );
    }

    const modelAccessor = getModelAccessor(clientToUse, operation.model as string);
    const modelDelegate = clientToUse[modelAccessor];

    if (!hasFindMany(modelDelegate)) {
      throw new Error(
        `Model ${operation.model} does not have findMany operation. This is required for batch operations.`,
      );
    }

    const whereClause =
      operation.args && typeof operation.args === 'object' && 'where' in operation.args ? operation.args.where : {};

    const beforeEntities = await modelDelegate.findMany({ where: whereClause || {} });
    const result = await query(operation.args);

    const afterEntities =
      action === AUDIT_ACTION.UPDATE_MANY ? await modelDelegate.findMany({ where: whereClause || {} }) : beforeEntities;

    const batchInitialContext: BatchInitialContext = {
      operation,
      auditContext: context,
      clientToUse,
      query,
      entities: afterEntities,
      beforeStates: beforeEntities,
    };

    await runBatchPipeline(batchInitialContext, baseClient);
    return result;
  };

  const handleBatchOperation = async (
    operation: OperationContext,
    context: AuditContext,
    query: (args: unknown) => Promise<unknown>,
    baseClient: PrismaClientWithDynamicAccess,
  ): Promise<unknown> => {
    try {
      const action = operation.action as PrismaAction;
      const clientToUse = (context.transactionalClient ?? baseClient) as
        | PrismaClientWithDynamicAccess
        | TransactionalPrismaClient;

      if (
        action === AUDIT_ACTION.CREATE_MANY &&
        operation.args &&
        typeof operation.args === 'object' &&
        'data' in operation.args &&
        Array.isArray((operation.args as { data: unknown }).data)
      ) {
        return handleCreateMany(operation, context, query, baseClient, clientToUse);
      }

      if ((action === AUDIT_ACTION.UPDATE_MANY || action === AUDIT_ACTION.DELETE_MANY) && operation.model) {
        return handleUpdateOrDeleteMany(operation, context, query, baseClient, clientToUse, action);
      }

      return query(operation.args);
    } catch (error) {
      handleError(error instanceof Error ? error : new Error(String(error)), `batch operation: ${operation.action}`);
      throw error;
    }
  };

  const extensionDefinition = (baseClient: PrismaClientWithDynamicAccess) => {
    const extendedClient = baseClient.$extends({
      name: 'prisma-audit',
      query: {
        $allModels: {
          async $allOperations(params: ExtensionParams) {
            const { operation, model, args, query } = params;

            const context = provider.getContext();

            if (context?._isProcessingAuditLog) {
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

            const processingContext: AuditContext = {
              ...(context as AuditContext),
              _isProcessingAuditLog: true,
            };

            return provider.runAsync(processingContext, async () => {
              const operationContext: OperationContext = {
                model,
                action: operation,
                args: argsWithInclude as Record<string, unknown>,
              };

              if (
                operation === AUDIT_ACTION.CREATE_MANY ||
                operation === AUDIT_ACTION.UPDATE_MANY ||
                operation === AUDIT_ACTION.DELETE_MANY
              ) {
                return handleBatchOperation(operationContext, processingContext, query, baseClient);
              }

              return handleSingleOperation(operationContext, processingContext, baseClient, (modifiedArgs) =>
                query(modifiedArgs ?? argsWithInclude),
              );
            });
          },
        },
      },
    });

    return createTransactionProxy(extendedClient as object, provider);
  };

  const Prisma = getPrisma();
  return Prisma.defineExtension(extensionDefinition);
};
