/**
 * Batch Operation Lifecycle Stages
 *
 * Defines lifecycle stages for batch operations (createMany, updateMany, deleteMany).
 * Follows the same pipeline pattern as single operations but operates on entity arrays.
 *
 * @module lifecycle/batch-stages
 */

import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import { createPrismaClientManager } from '../client-manager/index.js';
import type { AuditLogData, PrismaAction } from '../types.js';
import type { StageDependencies } from './stages.js';
import type { BatchEnrichedContext, BatchFinalContext, BatchInitialContext, LifecycleStage } from './types.js';

/**
 * Maps batch operations to singular equivalents for audit log generation.
 *
 * @internal
 */
const BATCH_TO_SINGULAR_ACTION: Record<string, PrismaAction> = {
  [AUDIT_ACTION.CREATE_MANY]: AUDIT_ACTION.CREATE,
  [AUDIT_ACTION.UPDATE_MANY]: AUDIT_ACTION.UPDATE,
  [AUDIT_ACTION.DELETE_MANY]: AUDIT_ACTION.DELETE,
} as const;

/**
 * Enriches entity contexts for all entities in a batch.
 *
 * If entity configuration exists, enriches entity contexts using batch enrichment.
 * Otherwise returns null contexts for all entities.
 *
 * NOTE: aggregateContext is no longer enriched at this stage. It is now enriched
 * per aggregate root inside buildAuditLog for aggregate-aware context.
 *
 * @internal
 */
const enrichBatchContexts = async (
  entities: ReadonlyArray<Record<string, unknown>>,
  entityConfig: ReturnType<StageDependencies['aggregateConfig']['getEntityConfig']>,
  clientToUse: unknown,
  batchEnrichEntityContexts: StageDependencies['batchEnrichEntityContexts'],
  modelName: string,
): Promise<ReadonlyArray<unknown | null>> => {
  if (!entityConfig) {
    return entities.map(() => null);
  }

  // NOTE: entityContext is shared across all aggregates, so we pass
  // temporary meta information (actual aggregate info is not needed here)
  const tempMeta = {
    aggregateType: modelName,
    aggregateCategory: 'model',
  };

  const entityContexts = await batchEnrichEntityContexts(
    entities as Record<string, unknown>[],
    entityConfig,
    clientToUse,
    tempMeta,
  );

  return entityContexts;
};

/**
 * Creates batch enrich contexts stage.
 *
 * Enriches actor and entity contexts for all entities in a batch operation.
 * Optimizes database queries by performing batch enrichment (N entities → 1 query per enricher).
 *
 * NOTE: aggregateContext is no longer enriched at this stage. It is now enriched
 * per aggregate root inside buildAuditLog for aggregate-aware context.
 *
 * Pipeline: BatchInitialContext → BatchEnrichedContext
 *
 * @param deps - Stage dependencies
 * @returns Lifecycle stage function
 *
 * @example
 * ```typescript
 * const enrichStage = createBatchEnrichContextsStage(stageDependencies);
 * const enrichedContext = await enrichStage(batchInitialContext);
 * ```
 */
export const createBatchEnrichContextsStage = (
  deps: StageDependencies,
): LifecycleStage<BatchInitialContext, BatchEnrichedContext> => {
  return async (context: BatchInitialContext): Promise<BatchEnrichedContext> => {
    const { operation, auditContext, clientToUse, entities } = context;
    const modelName = operation.model as string;

    const actorContext = await deps.enrichActorContext(auditContext, deps.contextEnricher?.actor, clientToUse);
    const entityConfig = deps.aggregateConfig.getEntityConfig(modelName);

    const entityContexts = await enrichBatchContexts(
      entities,
      entityConfig,
      clientToUse,
      deps.batchEnrichEntityContexts,
      modelName,
    );

    return {
      ...context,
      actorContext,
      entityContexts,
    };
  };
};

/**
 * Converts batch action to singular action for audit log generation.
 *
 * @internal
 */
const mapBatchActionToSingular = (batchAction: string): PrismaAction => {
  const singularAction = BATCH_TO_SINGULAR_ACTION[batchAction];
  if (!singularAction) {
    throw new Error(`Unknown batch action: ${batchAction}`);
  }
  return singularAction;
};

/**
 * Builds audit logs for a single entity in a batch operation.
 *
 * NOTE: aggregateContext parameter removed. Now enriched internally per aggregate root.
 *
 * @internal
 */
const buildLogsForEntity = async (
  entityIndex: number,
  context: BatchEnrichedContext,
  singularAction: PrismaAction,
  manager: ReturnType<typeof createPrismaClientManager>,
  deps: StageDependencies,
): Promise<AuditLogData[]> => {
  const { operation, auditContext, entities, beforeStates, actorContext, entityContexts } = context;

  const entity = entities[entityIndex];
  if (!entity) {
    return [];
  }

  const beforeState = beforeStates?.[entityIndex] ?? null;
  const entityContext = entityContexts[entityIndex] ?? null;
  const modelName = operation.model as string;

  return deps.buildAuditLog(
    entity as Record<string, unknown>,
    singularAction,
    auditContext,
    modelName,
    manager,
    actorContext,
    entityContext,
    beforeState,
    deps.aggregateConfig,
    deps.excludeFields,
    deps.redact,
  );
};

/**
 * Creates batch build logs stage.
 *
 * Generates audit log entries for all entities in a batch operation.
 * Each entity receives its own audit log with enriched contexts from the previous stage.
 *
 * Pipeline: BatchEnrichedContext → BatchFinalContext
 *
 * @param deps - Stage dependencies
 * @returns Lifecycle stage function
 *
 * @example
 * ```typescript
 * const buildLogsStage = createBatchBuildLogsStage(stageDependencies);
 * const finalContext = await buildLogsStage(batchEnrichedContext);
 * ```
 */
export const createBatchBuildLogsStage = (
  deps: StageDependencies,
): LifecycleStage<BatchEnrichedContext, BatchFinalContext> => {
  return async (context: BatchEnrichedContext): Promise<BatchFinalContext> => {
    const { operation, auditContext, entities } = context;

    const singularAction = mapBatchActionToSingular(operation.action as string);
    const manager = createPrismaClientManager(deps.basePrisma, auditContext);

    const allLogs: AuditLogData[] = [];
    for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
      const logs = await buildLogsForEntity(entityIndex, context, singularAction, manager, deps);
      allLogs.push(...logs);
    }

    return {
      ...context,
      logs: allLogs,
      result: undefined,
    };
  };
};
