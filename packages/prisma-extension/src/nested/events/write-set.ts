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
  targetWhereClauses,
  type UpsertBranch,
} from '../../grammar/nested-operations.js';
import type { SchemaMetadata } from '../../schema/types.js';
import { preFetchedStateAt } from '../pre-fetch/pre-fetch-result-store.js';

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
   * The row's pre-fetched before state: none when it did not exist under the parent or was not
   * pre-fetched, unavailable when the pre-fetch of the path failed
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
 * The branch an upsert took, from the pre-fetched state of its target: `update` when it existed,
 * `create` when it did not, unknown when the pre-fetch failed
 */
const upsertBranchOf = (before: BeforeState): UpsertBranch | undefined => {
  switch (before.kind) {
    case 'captured':
      return 'update';
    case 'none':
      return 'create';
    case 'unavailable':
      return undefined;
    default: {
      const exhaustiveCheck: never = before;
      throw new Error(`[@prisma-audit] Unhandled before state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * The nested operations an operation executes: the executed pass of the detection, with each
 * upsert taking the branch its pre-fetched target decides, and none when that target could not
 * be read.
 */
export const detectExecutedNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Row,
  topLevelUpsertBranch: UpsertBranch | undefined,
  nestedPreFetchResults: NestedPreFetchResults,
): NestedOperationInfo[] =>
  detectNestedOperations(schemaMetadata, modelName, args, {
    kind: 'executed',
    topLevelUpsertBranch,
    upsertBranchAt: (path, where) => upsertBranchOf(preFetchedStateAt(nestedPreFetchResults, path, where)),
  });

const INSERTING_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set(['create', 'createMany']);
const INSERTING_WHEN_TARGET_MISSING: ReadonlySet<NestedOperationKeyword> = new Set(['upsert', 'connectOrCreate']);

export const insertsRows = (operation: NestedOperationInfo, targets: readonly NestedWriteTarget[]): boolean =>
  INSERTING_KEYWORDS.has(operation.operation) ||
  (INSERTING_WHEN_TARGET_MISSING.has(operation.operation) && targets.some((target) => target.before.kind === 'none'));

/** The primary key of `row`, or undefined when the model has none or the row lacks one of its fields */
const primaryKeyOf = (row: Row, pkFields: readonly string[] | undefined): Row | undefined => {
  if (!pkFields || pkFields.some((field) => row[field] === undefined || row[field] === null)) {
    return undefined;
  }
  return Object.fromEntries(pkFields.map((field) => [field, row[field]]));
};

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
      before: preFetchedStateAt(nestedPreFetchResults, operation.path, key),
    }));
  }
  return targetWhereClauses(operation.operation, operation.data).map((where) => {
    const before = preFetchedStateAt(nestedPreFetchResults, operation.path, where);
    const key = before.kind === 'captured' ? primaryKeyOf(before.row, pkFields) : undefined;
    return {
      locator: key ? { by: 'primaryKey', where: key } : { by: 'uniqueWhere', where },
      operation,
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
