/**
 * Nested mutation event collection
 *
 * Detects the nested writes an executed operation performed, takes their rows from the result
 * (re-fetching by pre-fetched identity the ones the result did not include), resolves each
 * row's action and before-state, and yields one mutation event per nested record.
 */

import type { MutationEvent } from '@kuruwic/prisma-audit-core';
import { nestedLog, UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';

import {
  detectNestedOperations,
  extractNestedRecords,
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  type NestedRecordInfo,
  refetchNestedRecords,
  type UpsertBranch,
} from '../../grammar/nested-operations.js';
import type { GetOperationConfig } from '../../grammar/pre-fetch-selection.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import { identityOf, toMutationAction } from '../../pipeline/event-fields.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import type { CollectedNestedRecord } from './collected-record.js';
import { collectDeleteRecords, type UnresolvedDeleteEntityIdReporter } from './delete-handler.js';
import { collectNestedRecords } from './record-processor.js';

/**
 * Whether the record targeted by the nested upsert at `path` existed before the operation.
 *
 * Answered per path, not per row, so every upsert at one path takes the same branch: the entry
 * under `UNRESOLVED_ENTITY_ID` decides when present, else the first entry. A missing to-one row and
 * a failed pre-fetch are both stored there with a `null` before-state, so a path mixing found and
 * missing rows reads as missing.
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

export interface NestedEventCollectorDependencies {
  schemaMetadata: SchemaMetadata;
  getNestedOperationConfig: GetOperationConfig;
  /**
   * Notified when a nested delete's primary key cannot be resolved (see
   * `collectDeleteRecords`); that entry is skipped instead of being recorded with a
   * partial or guessed key. Optional: when omitted, the entry is still skipped, just
   * not reported.
   */
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter;
}

export interface NestedEventCollectionInput {
  modelName: string;
  args: Record<string, unknown>;
  result: unknown;
  /** Client the operation ran on; re-fetches the nested rows the result did not include */
  client: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  nestedPreFetchResults: NestedPreFetchResults;
  /** Branch the top-level upsert executed (only its nested writes are audited); `undefined` when not an upsert */
  topLevelUpsertBranch: UpsertBranch | undefined;
}

const toEvent = (
  record: CollectedNestedRecord,
  nestedOp: NestedOperationInfo,
  pkConstraint: UniqueConstraint,
): MutationEvent => ({
  model: record.relatedModel,
  identity: identityOf(record.entity, pkConstraint.fields),
  action: toMutationAction(record.action, record.beforeState),
  before: record.beforeState ?? undefined,
  after: record.entity,
  origin: { path: nestedOp.path, op: nestedOp.operation },
});

const collectRecordsAt = async (
  nestedOp: NestedOperationInfo,
  nestedRecordsInfo: readonly NestedRecordInfo[],
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  pkConstraint: UniqueConstraint,
  deps: NestedEventCollectorDependencies,
): Promise<CollectedNestedRecord[]> => {
  if (nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany') {
    return collectDeleteRecords(nestedOp, nestedPreFetchResults, pkConstraint, deps.onUnresolvedDeleteEntityId);
  }

  const recordsAtPath = nestedRecordsInfo.filter((info) => info.path === nestedOp.path);
  const first = recordsAtPath[0];
  if (!first) {
    return [];
  }

  return collectNestedRecords(
    nestedOp,
    { fieldName: first.fieldName, records: recordsAtPath.flatMap((info) => info.records), path: first.path },
    nestedPreFetchResults,
    deps.getNestedOperationConfig,
    pkConstraint.fields,
  );
};

/** One event per collected record, path by path in detection order; a path is collected once. */
const collectEventsOfPaths = async (
  nestedOperations: readonly NestedOperationInfo[],
  nestedRecordsInfo: readonly NestedRecordInfo[],
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  deps: NestedEventCollectorDependencies,
): Promise<MutationEvent[]> => {
  const events: MutationEvent[] = [];
  const processedPaths = new Set<string>();

  for (const nestedOp of nestedOperations) {
    if (processedPaths.has(nestedOp.path)) {
      continue;
    }
    processedPaths.add(nestedOp.path);

    const pkConstraint = getPrimaryKeyConstraint(deps.schemaMetadata, nestedOp.relatedModel);
    if (!pkConstraint) {
      nestedLog(
        'model=%s has no primary key; skipping nested records at path=%s',
        nestedOp.relatedModel,
        nestedOp.path,
      );
      continue;
    }

    const records = await collectRecordsAt(nestedOp, nestedRecordsInfo, nestedPreFetchResults, pkConstraint, deps);
    events.push(...records.map((record) => toEvent(record, nestedOp, pkConstraint)));
  }

  return events;
};

/**
 * Collect the events of the nested records an operation wrote
 *
 * 1. Detect the nested operations that executed and extract their records from the result,
 *    re-fetching the records of the paths the result did not include from the pre-fetched
 *    identities
 * 2. Resolve each record's action and before-state (`connect` records are skipped)
 *
 * With `include`, the records are the atomic, consistent rows of the operation itself. A
 * re-fetch is not atomic: it may observe state modified by another process.
 */
export const collectNestedEvents = async (
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
): Promise<MutationEvent[]> => {
  const { modelName, args, result, client, nestedPreFetchResults, topLevelUpsertBranch } = input;
  const { schemaMetadata } = deps;

  const nestedOperations = detectNestedOperations(schemaMetadata, modelName, args, {
    kind: 'executed',
    topLevelUpsertBranch,
    hasRecordAt: (path) => hasPreFetchedRecordAt(nestedPreFetchResults, path),
  });

  if (nestedOperations.length === 0) {
    return [];
  }

  let nestedRecordsInfo = extractNestedRecords(schemaMetadata, modelName, result);

  const missingOperations = nestedOperations.filter(
    (op) => !nestedRecordsInfo.some((record) => record.path === op.path),
  );

  if (missingOperations.length > 0 && nestedPreFetchResults.size > 0) {
    const refetchedRecords = await refetchNestedRecords(
      client as never,
      schemaMetadata,
      modelName,
      nestedPreFetchResults,
      missingOperations,
    );
    nestedRecordsInfo = [...nestedRecordsInfo, ...refetchedRecords];
  }

  return collectEventsOfPaths(nestedOperations, nestedRecordsInfo, nestedPreFetchResults, deps);
};
