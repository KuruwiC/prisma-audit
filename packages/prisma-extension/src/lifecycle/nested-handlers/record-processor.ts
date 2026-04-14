/**
 * Nested Record Processor
 *
 * Collects nested records (create/update/upsert) by resolving action and before state.
 * Enrichment and audit log building are handled by the batch pipeline in audit-log-builder.ts.
 */

import { nestedLog } from '@kuruwic/prisma-audit-core';

import type { PrismaAction } from '../../types.js';
import { extractEntityIdentity } from '../../utils/id-generator.js';
import type { CollectedNestedRecord } from './collected-record.js';
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
 * Checks if nested record should be skipped for audit logging
 *
 * Skips when action is 'connect' (connectOrCreate to existing record or connect operation).
 */
export const shouldSkipNestedRecord = (action: PrismaAction): boolean => {
  return action === ('connect' as PrismaAction);
};

/**
 * Collect nested records for create/update/upsert operations.
 *
 * Resolves action and before state for each record, skipping 'connect' operations.
 * Does NOT perform enrichment or build audit logs — that is the caller's responsibility.
 *
 * @returns Collected records ready for batch enrichment
 */
export const collectNestedRecords = (
  nestedOp: NestedOperationInfo,
  recordsInfo: NestedRecordsInfo,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  getNestedOperationConfig: GetNestedOperationConfig,
  pkFields?: string[],
): CollectedNestedRecord[] => {
  const collected: CollectedNestedRecord[] = [];

  nestedLog('collecting %d records for field=%s', recordsInfo.records.length, nestedOp.fieldName);

  for (const record of recordsInfo.records) {
    if (!record || typeof record !== 'object') {
      nestedLog('invalid record: %o', record);
      continue;
    }

    const recordObj = record as Record<string, unknown>;
    const entityId = extractEntityIdentity(recordObj, pkFields ?? ['id']);

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

    collected.push({
      entity: recordObj,
      action,
      beforeState,
      relatedModel: nestedOp.relatedModel,
    });
  }

  return collected;
};
