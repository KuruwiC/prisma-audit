/**
 * Nested Audit Log Builder
 *
 * Builds audit logs for nested operations using a batch pipeline:
 *   Phase 1 (collect): Gather all nested records, resolve action/beforeState
 *   Phase 2 (group):   Group collected records by relatedModel
 *   Phase 3 (enrich):  Batch entity + aggregate enrichment per model group
 *   Phase 4 (build):   Construct audit logs with pre-computed enrichment results
 */

import type {
  AggregateConfigService,
  AuditContext,
  NestedRecordInfo,
  PreFetchResults,
  RedactConfig,
  SerializationConfig,
} from '@kuruwic/prisma-audit-core';
import {
  batchEnrichEntityContexts,
  createEmptyPreFetchResults,
  detectNestedOperations,
  extractNestedRecords,
  type NestedOperationInfo,
  refetchNestedRecords,
} from '@kuruwic/prisma-audit-core';

import { buildAuditLog } from '../../audit-log-builder/index.js';
import { createPrismaClientManager } from '../../client-manager/index.js';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { AuditLogData } from '../../types.js';
import { getPrimaryKeyFields } from '../../utils/id-generator.js';
import { createSchemaMetadataFromDMMF } from '../../utils/nested-operations.js';
import {
  buildAggregateDataForEntity,
  enrichAggregateContexts,
  resolveAndFilterSurvivors,
  type SurvivorEntity,
} from '../batch-aggregate-resolver.js';
import { PRE_FETCH_INTERNAL_RESULTS } from '../pre-fetch/coordinator.js';
import { extractEntityIdOrDefault } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';
import {
  collectDeleteRecords,
  type NestedPreFetchResults,
  type UnresolvedDeleteEntityIdReporter,
} from './delete-handler.js';
import { collectNestedRecords } from './record-processor.js';
import type { GetNestedOperationConfig } from './state-resolver.js';

/**
 * Extract internal NestedPreFetchResults from PreFetchResults
 *
 * Uses Symbol-attached internal structure to preserve multiple entityIds per path,
 * which is essential for array operations like `connectOrCreate: [...]`.
 *
 * @internal
 */
const extractNestedPreFetchResults = (
  preFetchResults: PreFetchResults | undefined,
): NestedPreFetchResults | undefined => {
  if (!preFetchResults || preFetchResults.size === 0) {
    return undefined;
  }

  const internalResults = (preFetchResults as unknown as Record<symbol, unknown>)[PRE_FETCH_INTERNAL_RESULTS];
  if (internalResults && internalResults instanceof Map) {
    return internalResults as NestedPreFetchResults;
  }

  // Fallback: Convert flat structure for backward compatibility
  const nestedResults: NestedPreFetchResults = new Map();

  for (const [path, record] of preFetchResults) {
    const entityMap = new Map<string, { before: Record<string, unknown> | null }>();
    const entityId = extractEntityIdOrDefault(record);
    entityMap.set(entityId, { before: record as Record<string, unknown> | null });
    nestedResults.set(path, entityMap);
  }

  return nestedResults;
};

/**
 * Dependencies required for building nested audit logs
 */
export type NestedAuditLogBuilderDependencies = {
  aggregateConfig: AggregateConfigService;
  excludeFields: string[];
  redact: RedactConfig | undefined;
  serialization?: SerializationConfig;
  basePrisma: PrismaClientWithDynamicAccess;
  getNestedOperationConfig: GetNestedOperationConfig;
  Prisma: PrismaNamespace;
  /**
   * Notified when a nested delete's composite entityId cannot be reconstructed
   * (see `collectDeleteRecords`), instead of that entry being recorded with a
   * partial/guessed key. Optional: when omitted, the unresolved entry is still
   * skipped, just not reported.
   */
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter;
};

// ============================================================================
// Phase 1: Collect all nested records
// ============================================================================

const collectAllNestedRecords = async (
  nestedOperations: readonly NestedOperationInfo[],
  nestedRecordsInfo: readonly NestedRecordInfo[],
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  getNestedOperationConfig: GetNestedOperationConfig,
  Prisma: PrismaNamespace,
  onUnresolvedDeleteEntityId: UnresolvedDeleteEntityIdReporter | undefined,
): Promise<CollectedNestedRecord[]> => {
  const allCollected: CollectedNestedRecord[] = [];
  const processedPaths = new Set<string>();

  for (const nestedOp of nestedOperations) {
    if (processedPaths.has(nestedOp.path)) {
      continue;
    }
    processedPaths.add(nestedOp.path);

    let pkFields: string[] | undefined;
    try {
      pkFields = getPrimaryKeyFields(Prisma, nestedOp.relatedModel);
    } catch {
      // Model not found in DMMF — fall back to ['id']
    }

    if (nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany') {
      const deleteRecords = await collectDeleteRecords(
        nestedOp,
        nestedPreFetchResults,
        pkFields,
        onUnresolvedDeleteEntityId,
      );
      allCollected.push(...deleteRecords);
      continue;
    }

    const allRecordsForPath = nestedRecordsInfo.filter((info) => info.path === nestedOp.path);

    const recordsInfo =
      allRecordsForPath.length > 0 && allRecordsForPath[0]
        ? {
            fieldName: allRecordsForPath[0].fieldName,
            records: allRecordsForPath.flatMap((info) => info.records),
            path: allRecordsForPath[0].path,
          }
        : undefined;

    if (!recordsInfo) {
      continue;
    }

    const regularRecords = collectNestedRecords(
      nestedOp,
      recordsInfo,
      nestedPreFetchResults,
      getNestedOperationConfig,
      pkFields,
    );
    allCollected.push(...regularRecords);
  }

  return allCollected;
};

// ============================================================================
// Phase 2: Group collected records by relatedModel
// ============================================================================

interface ModelGroup {
  modelName: string;
  records: { collectedIndex: number; record: CollectedNestedRecord }[];
}

const groupByModel = (collected: CollectedNestedRecord[]): ModelGroup[] => {
  const groups = new Map<string, ModelGroup>();

  for (let i = 0; i < collected.length; i++) {
    const record = collected[i];
    if (!record) continue;

    let group = groups.get(record.relatedModel);
    if (!group) {
      group = { modelName: record.relatedModel, records: [] };
      groups.set(record.relatedModel, group);
    }
    group.records.push({ collectedIndex: i, record });
  }

  return Array.from(groups.values());
};

// ============================================================================
// Phase 3+4: Batch enrich and build per model group
// ============================================================================

const enrichAndBuildForModelGroup = async (
  group: ModelGroup,
  context: AuditContext,
  actorContext: unknown,
  basePrisma: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  deps: Pick<
    NestedAuditLogBuilderDependencies,
    'aggregateConfig' | 'excludeFields' | 'redact' | 'serialization' | 'Prisma'
  >,
): Promise<AuditLogData[]> => {
  const { aggregateConfig, excludeFields, redact, serialization, Prisma } = deps;
  const entityConfig = aggregateConfig.getEntityConfig(group.modelName);
  const nestedMetadata = createSchemaMetadataFromDMMF(Prisma);
  const relationFields = new Set(nestedMetadata.getRelationFields(group.modelName).map((f) => f.name));
  const entities = group.records.map((r) => r.record.entity);

  // Batch entity context enrichment (1 call per model)
  let entityContexts: (unknown | null)[];
  if (entityConfig) {
    entityContexts = await batchEnrichEntityContexts(entities, entityConfig, basePrisma);
  } else {
    entityContexts = entities.map(() => null);
  }

  // Batch aggregate resolution + enrichment
  const manager = createPrismaClientManager(basePrisma);
  let aggregateContextLookup = new Map<string, unknown>();
  let survivors: SurvivorEntity[] = [];

  if (entityConfig) {
    survivors = await resolveAndFilterSurvivors(entities, entityConfig, manager.activeClient);

    if (survivors.length > 0) {
      aggregateContextLookup = await enrichAggregateContexts(
        survivors,
        entityConfig,
        manager.activeClient,
        aggregateConfig.getEntityConfigByType,
      );
    }
  }

  // Build audit logs for survivors; non-survivor records with no aggregate
  // roots produce no audit logs (consistent with batch-stages.ts behavior)
  const allLogs: AuditLogData[] = [];

  for (const survivor of survivors) {
    const groupRecord = group.records[survivor.entityIndex];
    if (!groupRecord) continue;

    const aggregateData = buildAggregateDataForEntity(
      survivor.entityIndex,
      survivor.aggregateRoots,
      aggregateContextLookup,
    );

    const logs = await buildAuditLog({
      entity: groupRecord.record.entity,
      action: groupRecord.record.action,
      context,
      modelName: group.modelName,
      manager,
      actorContext,
      entityContext: entityContexts[survivor.entityIndex] ?? null,
      before: groupRecord.record.beforeState,
      aggregateConfig,
      excludeFields,
      redact,
      aggregateData,
      serialization,
      relationFieldNames: relationFields,
    });

    allLogs.push(...logs);
  }

  return allLogs;
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Operation-level input shared by {@link buildNestedAuditLogs} and the
 * `StageDependencies.buildNestedAuditLogs` dependency it is wired up as
 * (the dependency omits `deps`, which the caller binds via closure).
 */
export interface BuildNestedAuditLogsParams {
  modelName: string;
  args: Record<string, unknown>;
  result: unknown;
  context: AuditContext;
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  actorContext: unknown;
  preFetchResults?: PreFetchResults;
}

export interface BuildNestedAuditLogsInput extends BuildNestedAuditLogsParams {
  deps: NestedAuditLogBuilderDependencies;
}

/**
 * Build audit logs for nested records using batch pipeline.
 *
 * Pipeline:
 *   1. Detect nested operations and extract/refetch records
 *   2. Collect all records (resolve action, beforeState, skip connect)
 *   3. Group by relatedModel
 *   4. Per group: batch entity enrichment → batch aggregate resolution → batch aggregate enrichment → build logs
 */
export const buildNestedAuditLogs = async (input: BuildNestedAuditLogsInput): Promise<AuditLogData[]> => {
  const { modelName, args, result, context, prismaClient, actorContext, preFetchResults, deps } = input;
  const nestedPreFetchResults = extractNestedPreFetchResults(preFetchResults);
  const { aggregateConfig, excludeFields, redact, serialization, getNestedOperationConfig, Prisma } = deps;
  const onUnresolvedDeleteEntityId = deps.onUnresolvedDeleteEntityId;

  const prismaMetadata = createSchemaMetadataFromDMMF(Prisma);

  // Detect nested operations
  const preFetchResultsForDetection = preFetchResults ?? createEmptyPreFetchResults();
  const nestedOperations = detectNestedOperations(prismaMetadata, modelName, args, preFetchResultsForDetection);

  if (nestedOperations.length === 0) {
    return [];
  }

  // Extract/refetch nested records
  let nestedRecordsInfo = extractNestedRecords(prismaMetadata, modelName, result);

  const missingOperations = nestedOperations.filter((op) => {
    const hasRecord = nestedRecordsInfo.some((record) => record.path === op.path);
    return !hasRecord;
  });

  if (missingOperations.length > 0 && nestedPreFetchResults && nestedPreFetchResults.size > 0) {
    const refetchedRecords = await refetchNestedRecords(
      prismaClient as never,
      prismaMetadata as never,
      modelName,
      nestedPreFetchResults,
      missingOperations,
    );
    nestedRecordsInfo = [...nestedRecordsInfo, ...refetchedRecords];
  }

  // Phase 1: Collect all nested records
  const allCollected = await collectAllNestedRecords(
    nestedOperations,
    nestedRecordsInfo,
    nestedPreFetchResults,
    getNestedOperationConfig,
    Prisma,
    onUnresolvedDeleteEntityId,
  );

  if (allCollected.length === 0) {
    return [];
  }

  // Phase 2: Group by relatedModel
  const modelGroups = groupByModel(allCollected);

  // Phase 3+4: Batch enrich and build per model group
  const allLogs: AuditLogData[] = [];
  for (const group of modelGroups) {
    const logs = await enrichAndBuildForModelGroup(group, context, actorContext, prismaClient, {
      aggregateConfig,
      excludeFields,
      redact,
      serialization,
      Prisma,
    });
    allLogs.push(...logs);
  }

  return allLogs;
};
