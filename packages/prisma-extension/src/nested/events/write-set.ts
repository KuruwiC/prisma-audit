/**
 * Nested write set
 *
 * What a single operation writes below its top-level row, resolved before it runs: the nested
 * operations that execute (the branch of every upsert is known once the before-states are read)
 * and, per to-many path, the rows those operations name by unique WHERE or, for an `updateMany`
 * / `deleteMany`, the rows their filter matched when read ahead of the operation. A relation
 * written at a to-many path is read back whole, so the write set is what tells the rows an
 * operation wrote from their siblings. A create at a to-many path inserts rows: the write set holds
 * the keys the extension generated for them (`nested/inserted-row-keys`), and marks a path where
 * that does not tell them apart, so the rows the relation held before the operation can be
 * snapshotted.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import {
  detectNestedOperations,
  elementsOf,
  getPrimaryKeyConstraint,
  isNestedBatchKeyword,
  type NestedBatchTargets,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  type NestedPreFetchResults,
  namedTargets,
  type UpsertBranch,
} from '../../grammar/nested-operations.js';
import { upsertBranchOf } from '../../grammar/nested-state.js';
import type { SchemaMetadata } from '../../schema/types.js';
import { extractEntityIdentity, rowKeyOf } from '../../utils/id-generation.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import { isRecord } from '../../utils/is-record.js';
import { createDataOf, skipsDuplicates } from '../inserted-row-keys.js';
import { parentRowIdentityOf, targetsNamedByWhere } from '../pre-fetch/parent-rows.js';
import { preFetchedStateNamedBy, preFetchedStateUnder } from '../pre-fetch/pre-fetch-result-store.js';

type Row = Record<string, unknown>;

/**
 * How a row a nested operation writes is found in the result, or read again, after the write:
 * by its primary key when it was read ahead of the operation (its pre-fetched row, or a batch
 * filter's match), since the write may change the columns the operation names it by; otherwise
 * by the unique WHERE the operation names it by.
 */
export interface NestedRowLocator {
  readonly by: 'rowKey' | 'uniqueWhere';
  /** The primary-key fields and values, or the unique WHERE */
  readonly where: Row;
}

export interface NestedWriteTarget {
  readonly locator: NestedRowLocator;
  readonly operation: NestedOperationInfo;
  /**
   * The element of the operation's data that names the row; undefined for a row a batch filter
   * matched, which no element names on its own
   */
  readonly element: number | undefined;
  /**
   * The row's pre-fetched before state: none when it did not exist under the parent or was not
   * pre-fetched, unavailable when it could not be read
   */
  readonly before: BeforeState;
}

export interface NestedWriteSet {
  readonly targets: readonly NestedWriteTarget[];
  readonly generatedKeys: ReadonlySet<EntityIdentityKey>;
  /**
   * The generated keys do not tell the inserted rows apart, so any row the relation did not hold
   * before the operation counts as inserted
   */
  readonly anyNewRowIsInserted: boolean;
  /**
   * The rows the relation holds before the operation are read to tell the inserted rows apart: an
   * operation inserts a row whose key the extension did not generate, a `createMany` with
   * `skipDuplicates` may skip a row whose key was generated, or a write at the path gives a row
   * another key than the one generated for it
   */
  readonly readsPreExisting: boolean;
}

export const EMPTY_WRITE_SET: NestedWriteSet = {
  targets: [],
  generatedKeys: new Set(),
  anyNewRowIsInserted: false,
  readsPreExisting: false,
};

/**
 * Whether the row `identity` names at a path is one the operations there inserted: a row with a key
 * the extension generated for them, or any row when one of them inserts a row whose key it did not
 * generate or writes a key field; never a row the relation held before the operation
 * (`preExisting`, when it was read)
 */
export const isInsertedAt =
  (writeSet: NestedWriteSet, preExisting: ReadonlySet<EntityIdentityKey> | undefined) =>
  (identity: EntityIdentityKey): boolean =>
    (writeSet.generatedKeys.has(identity) || writeSet.anyNewRowIsInserted) && !preExisting?.has(identity);

/** Write sets keyed by to-many path; a to-one path has none, its single related row is what its operations write */
export type NestedWriteSets = ReadonlyMap<string, NestedWriteSet>;

/**
 * The nested operations an operation is resolved to write: the resolved pass of the detection,
 * with each upsert and connectOrCreate element taking the branch its pre-fetched target decides,
 * and none when that target could not be read. A to-many upsert or a connectOrCreate element names its
 * target by unique WHERE; a to-one upsert targets the related row of the row its parent element
 * names, so each parent row decides the branch of the upsert nested under it.
 */
export const detectResolvedNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Row,
  topLevelUpsertBranch: UpsertBranch | undefined,
  nestedPreFetchResults: NestedPreFetchResults,
): NestedOperationInfo[] =>
  detectNestedOperations(schemaMetadata, modelName, args, {
    kind: 'resolved',
    topLevelUpsertBranch,
    branchAt: (operation, where) => {
      if (!targetsNamedByWhere(operation)) {
        const parent = parentRowIdentityOf(operation.parent, nestedPreFetchResults, schemaMetadata);
        return upsertBranchOf(preFetchedStateUnder(nestedPreFetchResults, operation.path, parent));
      }
      return where ? upsertBranchOf(preFetchedStateNamedBy(nestedPreFetchResults, operation.path, where)) : undefined;
    },
  });

const INSERTING_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set(['create', 'createMany']);
const INSERTING_WHEN_TARGET_MISSING: ReadonlySet<NestedOperationKeyword> = new Set(['upsert', 'connectOrCreate']);

export const insertsRows = (operation: NestedOperationInfo, targets: readonly NestedWriteTarget[]): boolean =>
  INSERTING_KEYWORDS.has(operation.operation) ||
  (INSERTING_WHEN_TARGET_MISSING.has(operation.operation) && targets.some((target) => target.before.kind === 'none'));

/** The primary key of `row`, or undefined when the model has none or the row lacks one of its fields */
const completeRowKeyOf = (row: Row, keyFields: readonly string[] | undefined): Row | undefined =>
  !keyFields || keyFields.some((field) => row[field] === undefined || row[field] === null)
    ? undefined
    : rowKeyOf(row, keyFields);

const targetsOf = (
  operation: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults,
  batchTargets: NestedBatchTargets,
  keyFields: readonly string[] | undefined,
): NestedWriteTarget[] => {
  if (isNestedBatchKeyword(operation.operation)) {
    const matched = batchTargets.get(operation.path)?.get(operation.operation)?.values() ?? [];
    return Array.from(matched, (key) => ({
      locator: { by: 'rowKey', where: key },
      operation,
      element: undefined,
      before: preFetchedStateNamedBy(nestedPreFetchResults, operation.path, key),
    }));
  }
  return namedTargets(operation.operation, operation.data).map(({ element, where }) => {
    const before = preFetchedStateNamedBy(nestedPreFetchResults, operation.path, where);
    const key = before.kind === 'captured' ? completeRowKeyOf(before.row, keyFields) : undefined;
    return {
      locator: key ? { by: 'rowKey', where: key } : { by: 'uniqueWhere', where },
      operation,
      element,
      before,
    };
  });
};

/**
 * The data of the rows `operation` inserts: every row of a `create` or `createMany`, and the
 * `create` of each `upsert` or `connectOrCreate` element whose target did not exist
 */
const rowsInsertedBy = (operation: NestedOperationInfo, targets: readonly NestedWriteTarget[]): Row[] => {
  const rows = createDataOf(operation);
  if (INSERTING_KEYWORDS.has(operation.operation)) {
    return rows.map(({ data }) => data);
  }
  return rows.flatMap(({ element, data }) =>
    targets.some((target) => target.element === element && target.before.kind === 'none') ? [data] : [],
  );
};

interface WriteSetDraft {
  readonly targets: NestedWriteTarget[];
  readonly generatedKeys: Set<EntityIdentityKey>;
  anyNewRowIsInserted: boolean;
  readsPreExisting: boolean;
}

const updateDataOf = (operation: NestedOperationInfo): Row[] => {
  if (operation.operation !== 'update' && operation.operation !== 'updateMany' && operation.operation !== 'upsert') {
    return [];
  }
  const branch = operation.operation === 'upsert' ? 'update' : 'data';
  return elementsOf(operation.data).flatMap((element) => {
    const data = isRecord(element) ? element[branch] : undefined;
    return isRecord(data) ? [data] : [];
  });
};

/**
 * Whether `operation` writes a key field of the rows it updates, which can give a row the
 * operations at the path insert another key than the one the extension generated for it
 */
const writesKeyField = (operation: NestedOperationInfo, keyFields: readonly string[] | undefined): boolean =>
  keyFields !== undefined && updateDataOf(operation).some((data) => keyFields.some((field) => data[field] !== undefined));

/** Records in `writeSet` the key of each row `operation` inserts that the extension generated, else that the path inserts a row without one */
const addInsertedRows = (
  writeSet: WriteSetDraft,
  operation: NestedOperationInfo,
  inserted: readonly Row[],
  rowsWithGeneratedKeys: ReadonlySet<object>,
  keyFields: readonly string[] | undefined,
): void => {
  for (const row of inserted) {
    const key = rowsWithGeneratedKeys.has(row) ? completeRowKeyOf(row, keyFields) : undefined;
    if (key && keyFields) {
      writeSet.generatedKeys.add(extractEntityIdentity(key, keyFields));
    } else {
      writeSet.anyNewRowIsInserted = true;
    }
  }
  writeSet.readsPreExisting =
    writeSet.readsPreExisting || writeSet.anyNewRowIsInserted || (inserted.length > 0 && skipsDuplicates(operation));
};

/**
 * @param rowsWithGeneratedKeys - The data of each row the operations insert whose key the extension
 *   generated (`withInsertedRowKeys`)
 */
export const buildNestedWriteSets = (
  schemaMetadata: SchemaMetadata,
  operations: readonly NestedOperationInfo[],
  rowsWithGeneratedKeys: ReadonlySet<object>,
  nestedPreFetchResults: NestedPreFetchResults,
  batchTargets: NestedBatchTargets,
): NestedWriteSets => {
  const writeSets = new Map<string, WriteSetDraft>();

  for (const operation of operations) {
    if (!operation.isList) {
      continue;
    }
    const writeSet = writeSets.get(operation.path) ?? {
      targets: [],
      generatedKeys: new Set(),
      anyNewRowIsInserted: false,
      readsPreExisting: false,
    };
    writeSets.set(operation.path, writeSet);

    const keyFields = getPrimaryKeyConstraint(schemaMetadata, operation.relatedModel)?.fields;
    const targets = targetsOf(operation, nestedPreFetchResults, batchTargets, keyFields);
    writeSet.targets.push(...targets);

    addInsertedRows(writeSet, operation, rowsInsertedBy(operation, targets), rowsWithGeneratedKeys, keyFields);
    if (writesKeyField(operation, keyFields)) {
      writeSet.anyNewRowIsInserted = true;
      writeSet.readsPreExisting = true;
    }
  }

  return writeSets;
};
