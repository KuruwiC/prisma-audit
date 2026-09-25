/**
 * Nested write set
 *
 * What a single operation writes below its top-level row, resolved before it runs: the nested
 * operations that execute (the branch of every upsert is known once the before-states are read)
 * and, per to-many path, the rows those operations name by unique WHERE. A relation written at a
 * to-many path is read back whole, so the write set is what tells the rows an operation wrote
 * from their siblings. A create at a to-many path inserts rows whose identity is unknown until
 * the operation ran; the write set marks such a path so the rows the relation held before the
 * operation can be snapshotted.
 */

import {
  detectNestedOperations,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  type NestedPreFetchResults,
  targetWhereClauses,
  type UpsertBranch,
} from '../../grammar/nested-operations.js';
import type { SchemaMetadata } from '../../schema/types.js';
import { preFetchedRowAt } from '../pre-fetch/pre-fetch-result-store.js';

type Row = Record<string, unknown>;

/** A row a nested operation names by its unique WHERE */
export interface NestedWriteTarget {
  readonly where: Row;
  readonly operation: NestedOperationInfo;
  /** The row's pre-fetched before-state; `undefined` when it did not exist under the parent or was not pre-fetched */
  readonly before: Row | undefined;
}

/** The rows the nested operations at one to-many path write */
export interface NestedWriteSet {
  readonly targets: readonly NestedWriteTarget[];
  /** An operation at the path inserts rows whose identity is unknown before it runs */
  readonly createsPending: boolean;
}

/** Write sets keyed by to-many path; a to-one path has none, its single related row is what its operations write */
export type NestedWriteSets = ReadonlyMap<string, NestedWriteSet>;

/**
 * The nested operations an operation executes: the executed pass of the detection, with each
 * upsert taking the branch its pre-fetched target decides.
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
    hasRecordAt: (path, where) => preFetchedRowAt(nestedPreFetchResults, path, where) !== undefined,
  });

const INSERTING_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set(['create', 'createMany']);
const INSERTING_WHEN_TARGET_MISSING: ReadonlySet<NestedOperationKeyword> = new Set(['upsert', 'connectOrCreate']);

/**
 * Whether `operation` inserts rows: a create always does; an upsert or connectOrCreate does for
 * each target that did not exist before the operation.
 */
export const insertsRows = (operation: NestedOperationInfo, targets: readonly NestedWriteTarget[]): boolean =>
  INSERTING_KEYWORDS.has(operation.operation) ||
  (INSERTING_WHEN_TARGET_MISSING.has(operation.operation) && targets.some((target) => target.before === undefined));

/** Build the write set of every to-many path the executed nested operations write */
export const buildNestedWriteSets = (
  operations: readonly NestedOperationInfo[],
  nestedPreFetchResults: NestedPreFetchResults,
): NestedWriteSets => {
  const writeSets = new Map<string, { targets: NestedWriteTarget[]; createsPending: boolean }>();

  for (const operation of operations) {
    if (!operation.isList) {
      continue;
    }
    const writeSet = writeSets.get(operation.path) ?? { targets: [], createsPending: false };
    writeSets.set(operation.path, writeSet);

    const targets = targetWhereClauses(operation.operation, operation.data).map((where) => ({
      where,
      operation,
      before: preFetchedRowAt(nestedPreFetchResults, operation.path, where),
    }));
    writeSet.targets.push(...targets);
    writeSet.createsPending = writeSet.createsPending || insertsRows(operation, targets);
  }

  return writeSets;
};
