/**
 * Nested mutation event collection
 *
 * Attributes the rows an executed operation returned at each nested path to the nested
 * operations that wrote them (re-fetching the rows they updated that the result does not hold),
 * resolves each row's action and before-state, and yields one mutation event per row an
 * operation wrote.
 *
 * A to-many relation is returned whole, so a row there is an operation's only when the write set
 * says so: a row a target locates belongs to that operation (by the primary key of the row read
 * ahead of the operation, or else by its unique WHERE; see `NestedRowLocator`); a row that matches no
 * target and did not exist under the parent before the operation was inserted, and belongs to
 * the first operation at the path that inserts rows; any other row is a sibling and yields
 * nothing. A `deleteMany` yields one delete event per row its filter matched in that read. A
 * to-one path holds one related row per parent row, each the row of the operation nested under
 * that parent.
 */

import type { BeforeState, MutationEvent } from '@kuruwic/db-audit-core';
import {
  extractNestedRecords,
  getPrimaryKeyConstraint,
  linksNamedRows,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  type NestedRecordInfo,
} from '../../grammar/nested-operations.js';
import type { GetOperationConfig } from '../../grammar/pre-fetch-selection.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { matchesUniqueWhere } from '../../utils/compound-where.js';
import { nestedLog } from '../../utils/debug.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import { getPreFetchModelClient } from '../pre-fetch/model-client.js';
import type { PreExistingRows } from '../pre-fetch/pre-existing-rows.js';
import { extractEntityIdOrUnresolved, getPreFetchResult } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';
import {
  collectToManyDeleteRecords,
  collectToOneDeleteRecords,
  type UnresolvedDeleteEntityIdReporter,
} from './delete-handler.js';
import { identityOf } from './event-fields.js';
import { refetchNestedRecords } from './refetch-nested-records.js';
import { resolveNestedRowState } from './state-resolver.js';
import { insertsRows, type NestedWriteSet, type NestedWriteSets, type NestedWriteTarget } from './write-set.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

export interface NestedEventCollectorDependencies {
  schemaMetadata: SchemaMetadata;
  getNestedOperationConfig: GetOperationConfig;
  /**
   * Notified when a nested delete's primary key cannot be resolved (see `delete-handler.ts`);
   * that entry is skipped instead of being recorded with a partial or guessed key. Optional:
   * when omitted, the entry is still skipped, just not reported.
   */
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter;
}

export interface NestedEventCollectionInput {
  modelName: string;
  result: unknown;
  /** Client the operation ran on; re-fetches the nested rows the result does not hold */
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
  identity: identityOf(record.entity, pkConstraint.fields, { model: record.relatedModel, path: nestedOp.path }),
  action: record.action,
  before: record.beforeState,
  after: record.entity,
  origin: { path: nestedOp.path, op: nestedOp.operation },
});

const rowsByPath = (records: readonly NestedRecordInfo[]): Map<string, Row[]> => {
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
  before: BeforeState,
  getNestedOperationConfig: GetOperationConfig,
): CollectedNestedRecord | undefined => {
  const resolved = resolveNestedRowState(nestedOp, before, getNestedOperationConfig);
  if (resolved === undefined) {
    nestedLog(
      'no audit log for the %s row at path=%s (connected, or its target could not be read)',
      nestedOp.operation,
      nestedOp.path,
    );
    return undefined;
  }
  return {
    entity: row,
    action: resolved.action,
    beforeState: resolved.beforeState,
    relatedModel: nestedOp.relatedModel,
  };
};

const isLocatedBy = (row: Row, target: NestedWriteTarget): boolean => matchesUniqueWhere(row, target.locator.where);

const targetOf = (row: Row, targets: readonly NestedWriteTarget[]): NestedWriteTarget | undefined =>
  targets.find((target) => isLocatedBy(row, target));

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
    const record = resolveRow(nestedOp, row, NO_BEFORE_STATE, getNestedOperationConfig);
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
    const origin = { model: nestedOp.relatedModel, path: nestedOp.path };
    const isNew = (row: Row) => !(preExisting?.has(identityOf(row, pkFields, origin)) ?? false);
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
    const before = getPreFetchResult(nestedPreFetchResults, nestedOp.path, identity)?.before ?? NO_BEFORE_STATE;
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

  if (nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany') {
    return nestedOp.isList
      ? collectToManyDeleteRecords(
          nestedOp,
          input.writeSets.get(nestedOp.path)?.targets ?? [],
          pkConstraint,
          deps.onUnresolvedDeleteEntityId,
        )
      : collectToOneDeleteRecords(nestedOp, nestedPreFetchResults, pkConstraint, deps.onUnresolvedDeleteEntityId);
  }
  if (linksNamedRows(nestedOp.operation)) {
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
 * Whether `target` updated a row that existed before the operation: such a row is audited from its
 * after state, which only the result or a re-fetch holds.
 */
const updatesExistingRow = (target: NestedWriteTarget): boolean => {
  const { operation } = target.operation;
  return (
    operation === 'update' ||
    operation === 'updateMany' ||
    (operation === 'upsert' && target.before.kind === 'captured')
  );
};

/**
 * The rows returned at every nested path: from the result, plus a re-fetch of each row an
 * operation updated at a to-many path that the rows the result returned there do not hold. The
 * caller's own `include` or `select` on a written relation keeps its filter, and an update may
 * change the columns its own WHERE names, so the result may hold the siblings of an updated row
 * but not the row itself; the rows it does hold are used as returned.
 */
const returnedRows = async (
  input: NestedEventCollectionInput,
  schemaMetadata: SchemaMetadata,
  pkConstraints: ReadonlyMap<string, UniqueConstraint | undefined>,
): Promise<ReadonlyMap<string, readonly Row[]>> => {
  const { modelName, result, client, writeSets } = input;
  const rows = rowsByPath(extractNestedRecords(schemaMetadata, modelName, result));

  for (const [path, writeSet] of writeSets) {
    const rowsAtPath = rows.get(path) ?? [];
    const absent = writeSet.targets.filter(
      (target) => updatesExistingRow(target) && !rowsAtPath.some((row) => isLocatedBy(row, target)),
    );
    const relatedModel = absent[0]?.operation.relatedModel;
    if (relatedModel === undefined || !pkConstraints.get(path)) {
      continue;
    }
    const modelClient = getPreFetchModelClient(client, relatedModel);
    if (!modelClient) {
      throw new Error(`[@prisma-audit] Cannot re-fetch nested records: no model client for "${relatedModel}"`);
    }
    const refetched = await refetchNestedRecords(
      modelClient,
      absent.map((target) => target.locator),
    );
    rows.set(path, [...rowsAtPath, ...refetched]);
  }

  return rows;
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
  const rows = await returnedRows(input, schemaMetadata, pkConstraints);
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
