/**
 * Batch Operation Lifecycle Stages
 *
 * Defines lifecycle stages for batch operations (createMany, updateMany, deleteMany).
 * Follows the same pipeline pattern as single operations but operates on entity arrays.
 *
 * @module lifecycle/batch-stages
 */

import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';

import type { ResolvedAggregateData } from '../audit-log-builder/index.js';
import { createPrismaClientManager } from '../client-manager/index.js';
import type { PrismaClientWithDynamicAccess } from '../internal-types.js';
import type { AuditLogData, PrismaAction } from '../types.js';
import { createSchemaMetadataFromDMMF, getPrisma } from '../utils/schema-metadata.js';
import {
  batchEnrichAggregateContextsByType,
  buildAggregateDataForEntity,
  resetBatchResolveWarnings,
  resolveAndFilterSurvivors,
  type SurvivorEntity,
} from './batch-aggregate-resolver.js';
import type { StageDependencies } from './stages.js';
import type { BatchEnrichedContext, BatchFinalContext, BatchInitialContext, LifecycleStage } from './types.js';

export { resetBatchResolveWarnings };
export type { SurvivorEntity };

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
 * Aggregate context enrichment is handled in createBatchBuildLogsStage,
 * where entities are grouped by aggregateType for batch enrichment.
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

  let relationFields: Set<string> | undefined;
  try {
    const Prisma = getPrisma(deps.basePrisma as PrismaClientWithDynamicAccess);
    const metadata = createSchemaMetadataFromDMMF(Prisma);
    relationFields = new Set(metadata.getRelationFields(modelName).map((f) => f.name));
  } catch {
    // Prisma namespace not available — fall back to heuristic relation detection
  }

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
    aggregateData,
    undefined,
    deps.serialization,
    relationFields,
  );
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
    const { operation, auditContext, entities } = context;
    const modelName = operation.model as string;
    const singularAction = mapBatchActionToSingular(operation.action as string);
    const manager = createPrismaClientManager(deps.basePrisma, auditContext);
    const entityConfig = deps.aggregateConfig.getEntityConfig(modelName);

    // Phase 1: Resolve aggregate roots and filter out entities with zero roots
    const survivors = entityConfig
      ? await resolveAndFilterSurvivors(entities as Record<string, unknown>[], entityConfig, manager.activeClient)
      : [];

    // Phase 2: Batch-enrich aggregate contexts (only for survivors)
    const aggregateContextMap =
      survivors.length > 0 && entityConfig
        ? await batchEnrichAggregateContextsByType(survivors, entityConfig, manager.activeClient)
        : new Map<string, unknown>();

    // Phase 3: Build audit logs only for survivors
    const allLogs: AuditLogData[] = [];
    for (const survivor of survivors) {
      const aggregateData = buildAggregateDataForEntity(
        survivor.entityIndex,
        survivor.aggregateRoots,
        aggregateContextMap,
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
