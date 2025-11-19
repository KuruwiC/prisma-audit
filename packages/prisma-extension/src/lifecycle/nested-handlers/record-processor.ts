/**
 * Nested Record Processor
 *
 * Processes regular nested operations (create/update/upsert) by generating
 * audit logs for each nested record.
 */

import type { AggregateConfigService, AuditContext, RedactConfig } from '@kuruwic/prisma-audit-core';
import { batchEnrichEntityContexts, nestedLog } from '@kuruwic/prisma-audit-core';
import { buildAuditLog } from '../../audit-log-builder/index.js';
import { createPrismaClientManager } from '../../client-manager/index.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { AuditLogData, PrismaAction } from '../../types.js';
import type { NestedOperationInfo, NestedPreFetchResults } from './delete-handler.js';
import type { GetNestedOperationConfig } from './state-resolver.js';
import { resolveNestedOperationState } from './state-resolver.js';

/**
 * Nested records information
 */
export type NestedRecordsInfo = {
  fieldName: string;
  records: unknown[];
  path: string;
};

/**
 * Dependencies required for processing nested records
 */
export type RecordProcessorDependencies = {
  aggregateConfig: AggregateConfigService;
  excludeFields: string[];
  redact: RedactConfig | undefined;
  basePrisma: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  getNestedOperationConfig: GetNestedOperationConfig;
};

/**
 * Checks if nested record should be skipped for audit logging
 *
 * Skips when action is 'connect' (connectOrCreate to existing record or connect operation).
 *
 * @param action - Resolved action
 * @returns True if audit log should be skipped
 */
export const shouldSkipNestedRecord = (action: PrismaAction): boolean => {
  return action === ('connect' as PrismaAction);
};

/**
 * Process regular nested operations (create/update/upsert)
 *
 * Processes nested records by resolving action/before state, skipping 'connect' operations,
 * enriching entity contexts, and building audit logs.
 *
 * NOTE: aggregateContext is no longer enriched here. It is now enriched per aggregate root
 * inside buildAuditLog for aggregate-aware context.
 *
 * @param nestedOp - Nested operation information
 * @param recordsInfo - Nested records to process
 * @param context - Audit context
 * @param actorContext - Pre-enriched actor context
 * @param nestedPreFetchResults - Pre-fetched before states
 * @param deps - Dependencies (aggregateConfig, excludeFields, redact, basePrisma, getNestedOperationConfig)
 * @returns Audit logs for nested records
 *
 * @example
 * ```typescript
 * const logs = await processNestedRecord(
 *   { operation: 'create', fieldName: 'posts', relatedModel: 'Post', path: 'posts' },
 *   { fieldName: 'posts', records: [{ id: 1, title: 'New Post' }], path: 'posts' },
 *   context, actorContext, preFetchResults, deps
 * );
 * ```
 */
export const processNestedRecord = async (
  nestedOp: NestedOperationInfo,
  recordsInfo: NestedRecordsInfo,
  context: AuditContext,
  actorContext: unknown,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  deps: RecordProcessorDependencies,
): Promise<AuditLogData[]> => {
  const { aggregateConfig, excludeFields, redact, basePrisma, getNestedOperationConfig } = deps;
  const allNestedLogs: AuditLogData[] = [];

  nestedLog('found %d records for field=%s', recordsInfo.records.length, nestedOp.fieldName);

  // Generate audit logs for each nested record
  for (const record of recordsInfo.records) {
    if (!record || typeof record !== 'object') {
      nestedLog('invalid record: %o', record);
      continue;
    }

    // At this point, record is guaranteed to be an object (not null, not primitive)
    // We can safely treat it as Record<string, unknown>
    const recordObj = record as Record<string, unknown>;

    const entityId = 'id' in recordObj ? String(recordObj.id) : '__default__';

    const { action, beforeState } = resolveNestedOperationState(
      nestedOp,
      entityId,
      nestedPreFetchResults,
      getNestedOperationConfig,
    );

    if (shouldSkipNestedRecord(action)) {
      nestedLog('skipping audit log for connect operation: entityId=%s', entityId);
      continue;
    }

    const nestedEntityConfig = aggregateConfig.getEntityConfig(nestedOp.relatedModel);

    // Enrich entity context (shared across all aggregates)
    const tempMeta = {
      aggregateType: nestedOp.relatedModel,
      aggregateCategory: 'model',
    };

    const [nestedEntityContext] = nestedEntityConfig
      ? await batchEnrichEntityContexts([recordObj], nestedEntityConfig, basePrisma, tempMeta)
      : [null];

    const manager = createPrismaClientManager(basePrisma, context);
    const nestedLogs = await buildAuditLog(
      recordObj,
      action,
      context,
      nestedOp.relatedModel,
      manager,
      actorContext,
      nestedEntityContext,
      beforeState,
      aggregateConfig,
      excludeFields,
      redact,
    );

    allNestedLogs.push(...nestedLogs);
  }

  return allNestedLogs;
};
