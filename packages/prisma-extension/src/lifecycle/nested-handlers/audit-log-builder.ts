/**
 * Nested Audit Log Builder
 *
 * Builds audit logs for nested operations using two-phase detection strategy.
 */

import type {
  AggregateConfigService,
  AuditContext,
  NestedRecordInfo,
  PreFetchResults,
  RedactConfig,
} from '@kuruwic/prisma-audit-core';
import {
  createEmptyPreFetchResults,
  detectNestedOperations,
  extractNestedRecords,
  type NestedOperationInfo,
  refetchNestedRecords,
} from '@kuruwic/prisma-audit-core';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { AuditLogData } from '../../types.js';
import { createSchemaMetadataFromDMMF } from '../../utils/nested-operations.js';
import { PRE_FETCH_INTERNAL_RESULTS } from '../pre-fetch/coordinator.js';
import type { DeleteHandlerDependencies, NestedPreFetchResults } from './delete-handler.js';
import { handleNestedDelete } from './delete-handler.js';

/**
 * Extract internal NestedPreFetchResults from PreFetchResults
 *
 * Uses Symbol-attached internal structure to preserve multiple entityIds per path,
 * which is essential for array operations like `connectOrCreate: [...]`.
 *
 * @param preFetchResults - PreFetchResults with potentially attached internal results
 * @returns Nested Map structure (path → entityId → { before })
 * @internal
 */
const extractNestedPreFetchResults = (
  preFetchResults: PreFetchResults | undefined,
): NestedPreFetchResults | undefined => {
  if (!preFetchResults || preFetchResults.size === 0) {
    return undefined;
  }

  // Primary: Extract Symbol-attached internal results (preserves all entityIds)
  const internalResults = (preFetchResults as unknown as Record<symbol, unknown>)[PRE_FETCH_INTERNAL_RESULTS];
  if (internalResults && internalResults instanceof Map) {
    return internalResults as NestedPreFetchResults;
  }

  // Fallback: Convert flat structure for backward compatibility (loses multi-entity information)
  const nestedResults: NestedPreFetchResults = new Map();

  for (const [path, record] of preFetchResults) {
    const entityMap = new Map<string, { before: Record<string, unknown> | null }>();

    // Use actual record ID when available, otherwise use placeholder for null records (create operations)
    if (record && typeof record === 'object' && 'id' in record) {
      const recordId = String(record.id);
      entityMap.set(recordId, { before: record as Record<string, unknown> });
    } else {
      entityMap.set('__default__', { before: record });
    }

    nestedResults.set(path, entityMap);
  }

  return nestedResults;
};

import type { RecordProcessorDependencies } from './record-processor.js';
import { processNestedRecord } from './record-processor.js';
import type { GetNestedOperationConfig } from './state-resolver.js';

/**
 * Dependencies required for building nested audit logs
 */
export type NestedAuditLogBuilderDependencies = {
  aggregateConfig: AggregateConfigService;
  excludeFields: string[];
  redact: RedactConfig | undefined;
  basePrisma: PrismaClientWithDynamicAccess;
  getNestedOperationConfig: GetNestedOperationConfig;
  getPrisma: (client?: PrismaClientWithDynamicAccess) => PrismaNamespace;
};

/**
 * Build audit logs for nested records using two-phase detection strategy
 *
 * Uses pre-fetch results to filter conditional operations (upsert/connectOrCreate) to only
 * the branch that actually executed, preventing duplicate or phantom audit logs.
 *
 * Extraction Strategy:
 * - Primary: Extract from operation result (atomic, requires `include`)
 * - Fallback: Re-fetch using pre-fetch IDs (non-atomic, may capture concurrent changes)
 *
 * @param modelName - Parent model name
 * @param args - Operation arguments for detecting nested operations
 * @param result - Operation result containing nested records (if included)
 * @param context - Audit context
 * @param prismaClient - Prisma client for enrichment and refetch
 * @param actorContext - Pre-enriched actor context shared across nested logs
 * @param preFetchResults - Pre-fetched before states for filtering conditional branches
 * @param deps - Dependencies (aggregateConfig, excludeFields, redact, basePrisma, getNestedOperationConfig, getPrisma)
 * @returns Audit logs for nested records
 */
export const buildNestedAuditLogs = async (
  modelName: string,
  args: Record<string, unknown>,
  result: unknown,
  context: AuditContext,
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  actorContext: unknown,
  preFetchResults: PreFetchResults | undefined,
  deps: NestedAuditLogBuilderDependencies,
): Promise<AuditLogData[]> => {
  const nestedPreFetchResults = extractNestedPreFetchResults(preFetchResults);
  const { aggregateConfig, excludeFields, redact, getNestedOperationConfig, getPrisma } = deps;
  const allNestedLogs: AuditLogData[] = [];

  const prismaMetadata = createSchemaMetadataFromDMMF(getPrisma());

  // Detect nested operations, filtering conditional branches using pre-fetch results
  const preFetchResultsForDetection = preFetchResults ?? createEmptyPreFetchResults();
  const nestedOperations = detectNestedOperations(prismaMetadata, modelName, args, preFetchResultsForDetection);

  if (nestedOperations.length === 0) {
    return allNestedLogs;
  }

  let nestedRecordsInfo = extractNestedRecords(prismaMetadata, modelName, result);

  /**
   * Identify operations missing from extraction (requires refetch fallback)
   */
  const detectMissingOperations = (
    nestedOperations: readonly NestedOperationInfo[],
    extractedRecords: readonly NestedRecordInfo[],
  ): NestedOperationInfo[] => {
    return nestedOperations.filter((op) => {
      const hasRecord = extractedRecords.some((record) => record.path === op.path);
      return !hasRecord;
    });
  };

  /**
   * Refetch missing records using pre-fetch IDs (fallback when `include` not used)
   */
  const handleMissingOperationsRefetch = async (
    missingOperations: NestedOperationInfo[],
    currentRecords: NestedRecordInfo[],
  ): Promise<NestedRecordInfo[]> => {
    if (missingOperations.length === 0) {
      return currentRecords;
    }

    if (!nestedPreFetchResults || nestedPreFetchResults.size === 0) {
      return currentRecords;
    }

    const refetchedRecords = await refetchNestedRecords(
      prismaClient as never,
      prismaMetadata as never,
      modelName,
      nestedPreFetchResults,
      missingOperations,
    );

    return [...currentRecords, ...refetchedRecords];
  };

  const missingOperations = detectMissingOperations(nestedOperations, nestedRecordsInfo);
  nestedRecordsInfo = await handleMissingOperationsRefetch(missingOperations, nestedRecordsInfo);

  // Deduplicate processing: one audit log per unique path
  const processedPaths = new Set<string>();

  for (const nestedOp of nestedOperations) {
    if (processedPaths.has(nestedOp.path)) {
      continue;
    }
    processedPaths.add(nestedOp.path);

    const allRecordsForPath = nestedRecordsInfo.filter((info) => info.path === nestedOp.path);

    // Aggregate all records for the same path (handles array operations)
    const recordsInfo: NestedRecordInfo | undefined =
      allRecordsForPath.length > 0 && allRecordsForPath[0]
        ? {
            fieldName: allRecordsForPath[0].fieldName,
            relatedModel: allRecordsForPath[0].relatedModel,
            isList: allRecordsForPath[0].isList,
            path: allRecordsForPath[0].path,
            records: allRecordsForPath.flatMap((info) => info.records),
          }
        : undefined;

    if (nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany') {
      const deleteHandlerDeps: DeleteHandlerDependencies = {
        aggregateConfig,
        excludeFields,
        redact,
        basePrisma: prismaClient,
      };
      const deleteLogs = await handleNestedDelete(
        nestedOp,
        context,
        actorContext,
        nestedPreFetchResults,
        deleteHandlerDeps,
      );
      allNestedLogs.push(...deleteLogs);
      continue;
    }

    if (!recordsInfo) {
      continue;
    }

    const recordProcessorDeps: RecordProcessorDependencies = {
      aggregateConfig,
      excludeFields,
      redact,
      basePrisma: prismaClient,
      getNestedOperationConfig,
    };
    const regularLogs = await processNestedRecord(
      nestedOp,
      recordsInfo,
      context,
      actorContext,
      nestedPreFetchResults,
      recordProcessorDeps,
    );
    allNestedLogs.push(...regularLogs);
  }

  return allNestedLogs;
};
