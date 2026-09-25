/**
 * Nested Record Processor
 *
 * Collects nested records (create/update/upsert) by resolving action and before state.
 * The collected records become mutation events in collect-nested-events.ts.
 */

import { nestedLog } from '@kuruwic/prisma-audit-core';
import type { NestedOperationInfo, NestedPreFetchResults } from '../../grammar/nested-operations.js';
import type { GetOperationConfig } from '../../grammar/pre-fetch-selection.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import type { CollectedNestedRecord } from './collected-record.js';
import { type NestedRecordAction, resolveNestedOperationState } from './state-resolver.js';

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
const shouldSkipNestedRecord = (action: NestedRecordAction): action is 'connect' => {
  return action === 'connect';
};

/**
 * Collect nested records for create/update/upsert operations.
 *
 * Resolves action and before state for each record, skipping 'connect' operations.
 *
 * @returns Collected records, ready to become mutation events
 */
export const collectNestedRecords = (
  nestedOp: NestedOperationInfo,
  recordsInfo: NestedRecordsInfo,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  getNestedOperationConfig: GetOperationConfig,
  pkFields: string[],
): CollectedNestedRecord[] => {
  const collected: CollectedNestedRecord[] = [];

  nestedLog('collecting %d records for field=%s', recordsInfo.records.length, nestedOp.fieldName);

  for (const record of recordsInfo.records) {
    if (!record || typeof record !== 'object') {
      nestedLog('invalid record: %o', record);
      continue;
    }

    const recordObj = record as Record<string, unknown>;
    const entityId = extractEntityIdentity(recordObj, pkFields);

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
