/**
 * Batch Operation Lifecycle Stages
 *
 * Defines lifecycle stages for batch operations (createMany, updateMany, deleteMany).
 * Follows the same pipeline pattern as single operations but operates on entity arrays.
 *
 * @module lifecycle/batch-stages
 */

import { BATCH_TO_SINGULAR_ACTION } from '@kuruwic/prisma-audit-core';

import type { ResolvedAggregateData } from '../audit-log-builder/index.js';
import { createPrismaClientManager } from '../client-manager/index.js';
import type { AuditLogData, PrismaAction } from '../types.js';
import { createSchemaMetadataFromDMMF } from '../utils/schema-metadata.js';
import {
  buildAggregateDataForEntity,
  enrichAggregateContexts,
  resetBatchResolveWarnings,
  resolveAndFilterSurvivors,
  type SurvivorEntity,
} from './batch-aggregate-resolver.js';
import type { StageDependencies } from './stages.js';
import type { BatchEnrichedContext, BatchFinalContext, BatchInitialContext, LifecycleStage } from './types.js';

export { resetBatchResolveWarnings };
export type { SurvivorEntity };

/**
 * Enriches entity contexts for all entities in a batch.
 *
 * If entity configuration exists, enriches entity contexts using batch enrichment.
 * Otherwise returns null contexts for all entities.
 *
 * @internal
 */
const enrichBatchContexts = async (
  entities: ReadonlyArray<Record<string, unknown>>,
  entityConfig: ReturnType<StageDependencies['aggregateConfig']['getEntityConfig']>,
  clientToUse: unknown,
  batchEnrichEntityContexts: StageDependencies['batchEnrichEntityContexts'],
): Promise<ReadonlyArray<unknown | null>> => {
  if (!entityConfig) {
    return entities.map(() => null);
  }

  return await batchEnrichEntityContexts(entities as Record<string, unknown>[], entityConfig, clientToUse);
};

/**
 * Creates batch enrich contexts stage.
 *
 * Enriches actor and entity contexts for all entities in a batch operation.
 * Optimizes database queries by performing batch enrichment (N entities → 1 query per enricher).
 *
 * Aggregate context enrichment is handled in createBatchBuildLogsStage,
 * where entities are grouped by projection declaration for batch enrichment.
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
  const singularAction = BATCH_TO_SINGULAR_ACTION[batchAction as keyof typeof BATCH_TO_SINGULAR_ACTION];
  if (!singularAction) {
    throw new Error(`Unknown batch action: ${batchAction}`);
  }
  return singularAction;
};

/**
 * Builds audit logs for a single entity in a batch operation.
 *
 * Receives pre-computed ResolvedAggregateData from the batch stage.
 *
 * @internal
 */
const buildLogsForEntity = async (
  entityIndex: number,
  context: BatchEnrichedContext,
  singularAction: PrismaAction,
  manager: ReturnType<typeof createPrismaClientManager>,
  deps: StageDependencies,
  aggregateData: ResolvedAggregateData,
): Promise<AuditLogData[]> => {
  const { operation, auditContext, entities, beforeStates, actorContext, entityContexts } = context;

  const entity = entities[entityIndex];
  if (!entity) {
    return [];
  }

  const beforeState = beforeStates?.[entityIndex] ?? null;
  const entityContext = entityContexts[entityIndex] ?? null;
  const modelName = operation.model as string;

  const relationFields = new Set(
    createSchemaMetadataFromDMMF(deps.Prisma)
      .getRelationFields(modelName)
      .map((f) => f.name),
  );

  return deps.buildAuditLog({
    entity: entity as Record<string, unknown>,
    action: singularAction,
    context: auditContext,
    modelName,
    manager,
    actorContext,
    entityContext,
    before: beforeState,
    aggregateConfig: deps.aggregateConfig,
    excludeFields: deps.excludeFields,
    redact: deps.redact,
    aggregateData,
    serialization: deps.serialization,
    relationFieldNames: relationFields,
  });
};

/**
 * Creates batch build logs stage.
 *
 * Resolves aggregate roots and enriches aggregate contexts in batch before
 * building audit logs, following the same pattern as actor and entity enrichment.
 *
 * Pipeline: BatchEnrichedContext → BatchFinalContext
 */
export const createBatchBuildLogsStage = (
  deps: StageDependencies,
): LifecycleStage<BatchEnrichedContext, BatchFinalContext> => {
  return async (context: BatchEnrichedContext): Promise<BatchFinalContext> => {
    const { operation, entities } = context;
    const modelName = operation.model as string;
    const singularAction = mapBatchActionToSingular(operation.action as string);
    const manager = createPrismaClientManager(deps.basePrisma);
    const entityConfig = deps.aggregateConfig.getEntityConfig(modelName);

    const survivors = entityConfig
      ? await resolveAndFilterSurvivors(entities as Record<string, unknown>[], entityConfig, manager.activeClient)
      : [];

    const aggregateContextLookup =
      survivors.length > 0 && entityConfig
        ? await enrichAggregateContexts(
            survivors,
            entityConfig,
            manager.activeClient,
            deps.aggregateConfig.getEntityConfigByType,
          )
        : new Map<string, unknown>();

    const allLogs: AuditLogData[] = [];
    for (const survivor of survivors) {
      const aggregateData = buildAggregateDataForEntity(
        survivor.entityIndex,
        survivor.aggregateRoots,
        aggregateContextLookup,
      );
      const logs = await buildLogsForEntity(
        survivor.entityIndex,
        context,
        singularAction,
        manager,
        deps,
        aggregateData,
      );
      allLogs.push(...logs);
    }

    return { ...context, logs: allLogs, result: undefined };
  };
};
