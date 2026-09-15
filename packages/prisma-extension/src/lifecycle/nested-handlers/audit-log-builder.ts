/**
 * Nested Audit Log Builder
 *
 * Builds audit logs for nested operations using a batch pipeline:
 *   collect:          Gather all nested records, resolve action/beforeState
 *   group:            Group collected records by relatedModel
 *   enrich-and-build: Batch entity + aggregate enrichment, then construct audit logs, per model group
 */

import type {
  AggregateConfigService,
  AuditContext,
  NestedPreFetchResults,
  NestedRecordInfo,
  RedactConfig,
  SerializationConfig,
  UniqueConstraint,
  UpsertBranch,
} from '@kuruwic/prisma-audit-core';
import {
  batchEnrichEntityContexts,
  detectNestedOperations,
  extractNestedRecords,
  type NestedOperationInfo,
  refetchNestedRecords,
  UNRESOLVED_ENTITY_ID,
} from '@kuruwic/prisma-audit-core';

import { buildAuditLog } from '../../audit-log-builder/index.js';
import { createPrismaClientManager } from '../../client-manager/index.js';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { AuditLogData } from '../../types.js';
import { getPrimaryKeyConstraint } from '../../utils/id-generator.js';
import { createSchemaMetadataFromDMMF } from '../../utils/nested-operations.js';
import {
  buildAggregateDataForEntity,
  enrichAggregateContexts,
  resolveAndFilterSurvivors,
  type SurvivorEntity,
} from '../batch-aggregate-resolver.js';
import type { CollectedNestedRecord } from './collected-record.js';
import { collectDeleteRecords, type UnresolvedDeleteEntityIdReporter } from './delete-handler.js';
import { collectNestedRecords } from './record-processor.js';
import type { GetNestedOperationConfig } from './state-resolver.js';

/**
 * Whether the record targeted by the nested upsert at `path` existed before the operation, which
 * selects that upsert's `update` branch in the executed detection pass.
 *
 * Answered per path, not per row: the entry stored under `UNRESOLVED_ENTITY_ID` decides when one
 * exists, otherwise the first entry stored for the path does, and a path with no entry has no
 * record. Every upsert at one path is therefore treated as taking the same branch. The to-one
 * pre-fetch stores a row it did not find, and a failed pre-fetch, under `UNRESOLVED_ENTITY_ID`
 * with a `null` before-state, so a path whose rows are a mix of found and missing reads as missing.
 *
 * @internal
 */
const hasPreFetchedRecordAt = (nestedPreFetchResults: NestedPreFetchResults, path: string): boolean => {
  const pathMap = nestedPreFetchResults.get(path);
  if (!pathMap) {
    return false;
  }

  const entry = pathMap.get(UNRESOLVED_ENTITY_ID) ?? pathMap.values().next().value;
  return entry !== undefined && entry.before !== null;
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
   * Notified when a nested delete's primary key cannot be resolved (see
   * `collectDeleteRecords`); that entry is skipped instead of being recorded with a
   * partial or guessed key. Optional: when omitted, the entry is still skipped, just
   * not reported.
   */
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter;
};

// ============================================================================
// Collect all nested records
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

    let pkConstraint: UniqueConstraint | undefined;
    try {
      pkConstraint = getPrimaryKeyConstraint(Prisma, nestedOp.relatedModel);
    } catch {
      // Model not found in DMMF — fall back to ['id']
    }

    if (nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany') {
      const deleteRecords = await collectDeleteRecords(
        nestedOp,
        nestedPreFetchResults,
        pkConstraint,
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
      pkConstraint?.fields,
    );
    allCollected.push(...regularRecords);
  }

  return allCollected;
};

// ============================================================================
// Group collected records by relatedModel
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
// Enrich and build per model group
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
  /** Before-states pre-fetched ahead of the operation, keyed by operation path, then by entity identity */
  nestedPreFetchResults: NestedPreFetchResults;
  /**
   * The branch the top-level upsert executed, whose nested writes are the ones audited;
   * `undefined` when the operation is not an upsert.
   */
  topLevelUpsertBranch: UpsertBranch | undefined;
}

export interface BuildNestedAuditLogsInput extends BuildNestedAuditLogsParams {
  deps: NestedAuditLogBuilderDependencies;
}

/**
 * Build audit logs for nested records using batch pipeline.
 *
 * Pipeline:
 *   1. Detect the nested operations that executed and extract/refetch records
 *   2. Collect all records (resolve action, beforeState, skip connect)
 *   3. Group by relatedModel
 *   4. Per group: batch entity enrichment → batch aggregate resolution → batch aggregate enrichment → build logs
 */
export const buildNestedAuditLogs = async (input: BuildNestedAuditLogsInput): Promise<AuditLogData[]> => {
  const {
    modelName,
    args,
    result,
    context,
    prismaClient,
    actorContext,
    nestedPreFetchResults,
    topLevelUpsertBranch,
    deps,
  } = input;
  const {
    aggregateConfig,
    excludeFields,
    redact,
    serialization,
    getNestedOperationConfig,
    Prisma,
    onUnresolvedDeleteEntityId,
  } = deps;

  const prismaMetadata = createSchemaMetadataFromDMMF(Prisma);

  const nestedOperations = detectNestedOperations(prismaMetadata, modelName, args, {
    kind: 'executed',
    topLevelUpsertBranch,
    hasRecordAt: (path) => hasPreFetchedRecordAt(nestedPreFetchResults, path),
  });

  if (nestedOperations.length === 0) {
    return [];
  }

  // Extract/refetch nested records
  let nestedRecordsInfo = extractNestedRecords(prismaMetadata, modelName, result);

  const missingOperations = nestedOperations.filter((op) => {
    const hasRecord = nestedRecordsInfo.some((record) => record.path === op.path);
    return !hasRecord;
  });

  if (missingOperations.length > 0 && nestedPreFetchResults.size > 0) {
    const refetchedRecords = await refetchNestedRecords(
      prismaClient as never,
      prismaMetadata as never,
      modelName,
      nestedPreFetchResults,
      missingOperations,
    );
    nestedRecordsInfo = [...nestedRecordsInfo, ...refetchedRecords];
  }

  // Collect all nested records
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

  // Group by relatedModel
  const modelGroups = groupByModel(allCollected);

  // Enrich and build per model group
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
