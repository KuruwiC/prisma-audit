/**
 * Nested write set
 *
 * What a single operation writes below its top-level row, resolved before it runs: the nested
 * operations that execute (the branch of every upsert is known once the before-states are read)
 * and, per to-many path, the rows those operations name by unique WHERE or, for an `updateMany`
 * / `deleteMany`, the rows their filter matched when read ahead of the operation. A relation
 * written at a to-many path is read back whole, so the write set is what tells the rows an
 * operation wrote from their siblings. A create at a to-many path inserts rows whose identity is
 * unknown until the operation ran; the write set marks such a path so the rows the relation held
 * before the operation can be snapshotted.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import {
  detectNestedOperations,
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
import { primaryKeyOf } from '../../utils/id-generation.js';
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
  readonly by: 'primaryKey' | 'uniqueWhere';
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
  /** An operation at the path inserts rows whose identity is unknown before it runs */
  readonly createsPending: boolean;
}

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
const completePrimaryKeyOf = (row: Row, pkFields: readonly string[] | undefined): Row | undefined =>
  !pkFields || pkFields.some((field) => row[field] === undefined || row[field] === null)
    ? undefined
    : primaryKeyOf(row, pkFields);

const targetsOf = (
  operation: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults,
  batchTargets: NestedBatchTargets,
  pkFields: readonly string[] | undefined,
): NestedWriteTarget[] => {
  if (isNestedBatchKeyword(operation.operation)) {
    const matched = batchTargets.get(operation.path)?.get(operation.operation)?.values() ?? [];
    return Array.from(matched, (key) => ({
      locator: { by: 'primaryKey', where: key },
      operation,
      element: undefined,
      before: preFetchedStateNamedBy(nestedPreFetchResults, operation.path, key),
    }));
  }
  return namedTargets(operation.operation, operation.data).map(({ element, where }) => {
    const before = preFetchedStateNamedBy(nestedPreFetchResults, operation.path, where);
    const key = before.kind === 'captured' ? completePrimaryKeyOf(before.row, pkFields) : undefined;
    return {
      locator: key ? { by: 'primaryKey', where: key } : { by: 'uniqueWhere', where },
      operation,
      element,
      before,
    };
  });
};

export const buildNestedWriteSets = (
  schemaMetadata: SchemaMetadata,
  operations: readonly NestedOperationInfo[],
  nestedPreFetchResults: NestedPreFetchResults,
  batchTargets: NestedBatchTargets,
): NestedWriteSets => {
  const writeSets = new Map<string, { targets: NestedWriteTarget[]; createsPending: boolean }>();

  for (const operation of operations) {
    if (!operation.isList) {
      continue;
    }
    const writeSet = writeSets.get(operation.path) ?? { targets: [], createsPending: false };
    writeSets.set(operation.path, writeSet);

    const pkFields = getPrimaryKeyConstraint(schemaMetadata, operation.relatedModel)?.fields;
    const targets = targetsOf(operation, nestedPreFetchResults, batchTargets, pkFields);
    writeSet.targets.push(...targets);
    writeSet.createsPending = writeSet.createsPending || insertsRows(operation, targets);
  }

  return writeSets;
};
