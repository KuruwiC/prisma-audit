/**
 * Nested mutation event collection
 *
 * Attributes the rows an executed operation returned at each nested path to the nested
 * operations that wrote them (re-fetching by pre-fetched identity the rows the result did not
 * include), resolves each row's action and before-state, and yields one mutation event per row
 * an operation wrote.
 *
 * A to-many relation is returned whole, so a row there is an operation's only when the write set
 * says so: a row a target names belongs to that operation (a unique WHERE, or the primary key of
 * a row an `updateMany` filter matched when read ahead of the operation); a row that matches no
 * target and did not exist under the parent before the operation was inserted, and belongs to
 * the first operation at the path that inserts rows; any other row is a sibling and yields
 * nothing. A `deleteMany` yields one delete event per row its filter matched in that read. A
 * to-one path holds one related row per parent row, each the row of the operation nested under
 * that parent.
 */

import type { EntityIdentityKey, MutationEvent } from '@kuruwic/prisma-audit-core';
import { nestedLog } from '@kuruwic/prisma-audit-core';

import {
  extractNestedRecords,
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  type NestedRecordInfo,
  refetchNestedRecords,
} from '../../grammar/nested-operations.js';
import type { GetOperationConfig } from '../../grammar/pre-fetch-selection.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import { identityOf, toMutationAction } from '../../pipeline/event-fields.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { matchesUniqueWhere } from '../../utils/compound-where.js';
import type { PreExistingRows } from '../pre-fetch/pre-existing-rows.js';
import { extractEntityIdOrUnresolved, getPreFetchResult } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';
import {
  collectDeleteManyRecords,
  collectDeleteRecords,
  type UnresolvedDeleteEntityIdReporter,
} from './delete-handler.js';
import { resolveNestedRowState } from './state-resolver.js';
import { insertsRows, type NestedWriteSet, type NestedWriteSets, type NestedWriteTarget } from './write-set.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

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
  result: unknown;
  /** Client the operation ran on; re-fetches the nested rows the result did not include */
  client: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  nestedPreFetchResults: NestedPreFetchResults;
  /** The nested operations the operation executed, in detection order */
  nestedOperations: readonly NestedOperationInfo[];
  writeSets: NestedWriteSets;
  preExistingRows: PreExistingRows;
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

/** The rows returned at each path, from the result and the re-fetch */
const rowsByPath = (records: readonly NestedRecordInfo[]): ReadonlyMap<string, readonly Row[]> => {
  const rows = new Map<string, Row[]>();
  for (const info of records) {
    const atPath = rows.get(info.path) ?? [];
    rows.set(info.path, atPath);
    atPath.push(...info.records.filter(isRow));
  }
  return rows;
};

const resolveRow = (
  nestedOp: NestedOperationInfo,
  row: Row,
  before: Row | undefined,
  getNestedOperationConfig: GetOperationConfig,
): CollectedNestedRecord | undefined => {
  const { action, beforeState } = resolveNestedRowState(nestedOp, before, getNestedOperationConfig);
  if (action === 'connect') {
    nestedLog('skipping audit log for connect operation at path=%s', nestedOp.path);
    return undefined;
  }
  return { entity: row, action, beforeState, relatedModel: nestedOp.relatedModel };
};

const targetOf = (row: Row, targets: readonly NestedWriteTarget[]): NestedWriteTarget | undefined =>
  targets.find((target) => matchesUniqueWhere(row, target.where));

/** The rows returned at one path and, shared by the operations at the path, the rows already attributed */
interface PathAttribution {
  readonly rows: readonly Row[];
  readonly pkFields: readonly string[];
  readonly writeSet: NestedWriteSet;
  readonly preExisting: ReadonlySet<EntityIdentityKey> | undefined;
  readonly claimed: Set<Row>;
}

/**
 * The rows at the path no operation named or claimed that `accept` admits, attributed to
 * `nestedOp` as rows it wrote without naming them.
 */
const claimUnnamedRows = (
  nestedOp: NestedOperationInfo,
  attribution: PathAttribution,
  accept: (row: Row) => boolean,
  getNestedOperationConfig: GetOperationConfig,
): CollectedNestedRecord[] => {
  const { rows, writeSet, claimed } = attribution;
  const collected: CollectedNestedRecord[] = [];
  for (const row of rows) {
    if (claimed.has(row) || targetOf(row, writeSet.targets) || !accept(row)) {
      continue;
    }
    claimed.add(row);
    const record = resolveRow(nestedOp, row, undefined, getNestedOperationConfig);
    if (record) collected.push(record);
  }
  return collected;
};

/**
 * The rows at a to-many path `nestedOp` wrote: those its targets name and, for an operation that
 * inserts rows, the unclaimed rows that did not exist under the parent before.
 */
const collectToManyRows = (
  nestedOp: NestedOperationInfo,
  attribution: PathAttribution,
  getNestedOperationConfig: GetOperationConfig,
): CollectedNestedRecord[] => {
  const { rows, writeSet, preExisting, pkFields, claimed } = attribution;
  const ownTargets = writeSet.targets.filter((target) => target.operation === nestedOp);
  const collected: CollectedNestedRecord[] = [];

  for (const row of rows) {
    const target = targetOf(row, ownTargets);
    if (!target) {
      continue;
    }
    claimed.add(row);
    const record = resolveRow(nestedOp, row, target.before, getNestedOperationConfig);
    if (record) collected.push(record);
  }

  if (insertsRows(nestedOp, ownTargets)) {
    const isNew = (row: Row) => !(preExisting?.has(identityOf(row, pkFields)) ?? false);
    return [...collected, ...claimUnnamedRows(nestedOp, attribution, isNew, getNestedOperationConfig)];
  }
  return collected;
};

/** The rows at a to-one path, each resolved with the before-state pre-fetched under its own identity */
const collectToOneRows = (
  nestedOp: NestedOperationInfo,
  attribution: PathAttribution,
  nestedPreFetchResults: NestedPreFetchResults,
  getNestedOperationConfig: GetOperationConfig,
): CollectedNestedRecord[] =>
  attribution.rows.flatMap((row) => {
    const identity = extractEntityIdOrUnresolved(row, [...attribution.pkFields]);
    const before = getPreFetchResult(nestedPreFetchResults, nestedOp.path, identity)?.before ?? undefined;
    return resolveRow(nestedOp, row, before, getNestedOperationConfig) ?? [];
  });

const collectRecordsOf = async (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  attributions: Map<string, PathAttribution>,
  pkConstraint: UniqueConstraint,
  deps: NestedEventCollectorDependencies,
): Promise<CollectedNestedRecord[]> => {
  const { nestedPreFetchResults } = input;
  const { getNestedOperationConfig } = deps;

  if (nestedOp.operation === 'deleteMany') {
    return collectDeleteManyRecords(nestedOp, input.writeSets.get(nestedOp.path)?.targets ?? []);
  }
  if (nestedOp.operation === 'delete') {
    return collectDeleteRecords(nestedOp, nestedPreFetchResults, pkConstraint, deps.onUnresolvedDeleteEntityId);
  }
  if (nestedOp.operation === 'connect') {
    return [];
  }

  const attribution = attributions.get(nestedOp.path);
  if (!attribution) {
    return [];
  }
  if (!nestedOp.isList) {
    return collectToOneRows(nestedOp, attribution, nestedPreFetchResults, getNestedOperationConfig);
  }
  return collectToManyRows(nestedOp, attribution, getNestedOperationConfig);
};

const attributionsOf = (
  rows: ReadonlyMap<string, readonly Row[]>,
  input: NestedEventCollectionInput,
  pkConstraints: ReadonlyMap<string, UniqueConstraint | undefined>,
): Map<string, PathAttribution> => {
  const attributions = new Map<string, PathAttribution>();
  for (const [path, rowsAtPath] of rows) {
    const pkConstraint = pkConstraints.get(path);
    if (!pkConstraint) {
      continue;
    }
    attributions.set(path, {
      rows: rowsAtPath,
      pkFields: pkConstraint.fields,
      writeSet: input.writeSets.get(path) ?? { targets: [], createsPending: false },
      preExisting: input.preExistingRows.get(path),
      claimed: new Set(),
    });
  }
  return attributions;
};

/**
 * The rows returned at every nested path: from the result, plus a re-fetch by pre-fetched
 * identity for the paths the result did not include.
 *
 * With `include`, the records are the atomic, consistent rows of the operation itself. A
 * re-fetch is not atomic: it may observe state modified by another process.
 */
const returnedRows = async (
  input: NestedEventCollectionInput,
  schemaMetadata: SchemaMetadata,
): Promise<ReadonlyMap<string, readonly Row[]>> => {
  const { modelName, result, client, nestedPreFetchResults, nestedOperations } = input;
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

  return rowsByPath(nestedRecordsInfo);
};

/**
 * Collect the events of the nested records an operation wrote: one per row each executed nested
 * operation is attributed, operation by operation in detection order.
 */
export const collectNestedEvents = async (
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
): Promise<MutationEvent[]> => {
  const { nestedOperations } = input;
  const { schemaMetadata } = deps;

  if (nestedOperations.length === 0) {
    return [];
  }

  const pkConstraints = new Map(
    nestedOperations.map((op) => [op.path, getPrimaryKeyConstraint(schemaMetadata, op.relatedModel)]),
  );
  const rows = await returnedRows(input, schemaMetadata);
  const attributions = attributionsOf(rows, input, pkConstraints);
  const events: MutationEvent[] = [];

  for (const nestedOp of nestedOperations) {
    const pkConstraint = pkConstraints.get(nestedOp.path);
    if (!pkConstraint) {
      nestedLog(
        'model=%s has no primary key; skipping nested records at path=%s',
        nestedOp.relatedModel,
        nestedOp.path,
      );
      continue;
    }
    const records = await collectRecordsOf(nestedOp, input, attributions, pkConstraint, deps);
    events.push(...records.map((record) => toEvent(record, nestedOp, pkConstraint)));
  }

  return events;
};
