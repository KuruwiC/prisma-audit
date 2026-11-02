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
 *
 * Telling rows apart by key holds only while each row the operations write is located by the key
 * it has after the write. Targets that name different rows but are located by the same key, and a
 * target that names the key another target's write gives a row, cannot be told apart: neither is
 * located. At a path holding a target that is not located, a row the snapshot does not hold may be
 * that target's row under its new key, so the rows inserted there without a key the extension
 * generated are not inferred as inserted.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import {
  detectNestedOperations,
  getRowKeyConstraint,
  isNestedBatchKeyword,
  type NestedBatchTargets,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  type NestedPreFetchResults,
  namedTargets,
  type UpsertBranch,
  updateDataOf,
} from '../../grammar/nested-operations.js';
import { TOP_LEVEL_ROW, upsertBranchOf } from '../../grammar/nested-state.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { extractEntityIdentity, rowKeyOf } from '../../utils/id-generation.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import { isRecord } from '../../utils/is-record.js';
import {
  NO_ROW_KEY_WRITE,
  type PrismaValues,
  type RowKeyWrite,
  rowKeyWriteOf,
  withWrittenKey,
} from '../../utils/row-key-write.js';
import { createDataOf, skipsDuplicates } from '../inserted-row-keys.js';
import { type KeyLink, keyLinkOf, withoutKeyLink } from '../key-link.js';
import { parentRowIdentityOf, targetsNamedByWhere } from '../pre-fetch/parent-rows.js';
import { preFetchedStateNamedBy, preFetchedStateUnder, rowKeyNamedBy } from '../pre-fetch/pre-fetch-result-store.js';

type Row = Record<string, unknown>;

/**
 * How a row a nested operation writes is found in the result, or read again, after the write:
 * - `rowKey`: by the key the write gives it, when its row key is known ahead of the operation (its
 *   pre-fetched row, a batch filter's match, or, for an update that writes the key, a WHERE that
 *   names the whole key): that key with the key fields the data gives literal values replaced
 *   ({@link withWrittenKey}), since the write may change the columns the operation names it by;
 * - `uniqueWhere`: otherwise, by the unique WHERE the operation names it by;
 * - `unknown`: not at all, when the data changes the key in a way its arguments do not tell (an
 *   operator on a key field, or a relation whose foreign key holds one), or when another target at
 *   the path cannot be told apart from it by key.
 *
 * The row-key fields that hold the foreign key to the parent row are taken from the parent row as
 * it is after the write where the row is looked for (`nested/key-link`).
 */
export type NestedRowLocator =
  | {
      readonly by: 'rowKey' | 'uniqueWhere';
      /** The row-key fields and values, or the unique WHERE */
      readonly where: Row;
    }
  | { readonly by: 'unknown' };

/** A target whose locator names its row */
export interface LocatedTarget extends NestedWriteTarget {
  readonly locator: Extract<NestedRowLocator, { readonly where: Row }>;
}

export const isLocated = (target: NestedWriteTarget): target is LocatedTarget => target.locator.by !== 'unknown';

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
   * before the operation counts as inserted; never at a path holding a target that is not located,
   * whose row such a row may be (`unidentifiedInserts`)
   */
  readonly anyNewRowIsInserted: boolean;
  /**
   * The number of rows each operation inserts without a key the extension generated at a path
   * holding a target that is not located: they are not inferred as inserted
   */
  readonly unidentifiedInserts: ReadonlyMap<NestedOperationInfo, number>;
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
  unidentifiedInserts: new Map(),
  readsPreExisting: false,
};

/**
 * Whether the row `identity` names at a path is one the operations there inserted: a row with a key
 * the extension generated for them, or any row when one of them inserts a row whose key it did not
 * generate or writes a key field; never a row the relation held before the operation
 * (`preExisting`, when it was read). `identityBeforeWrite` is the key the row had before the write
 * when the parent row's write changed it (`nested/key-link`), the key the snapshot holds it by.
 */
export const isInsertedAt =
  (writeSet: NestedWriteSet, preExisting: ReadonlySet<EntityIdentityKey> | undefined) =>
  (identity: EntityIdentityKey, identityBeforeWrite: EntityIdentityKey = identity): boolean =>
    (writeSet.generatedKeys.has(identity) || writeSet.anyNewRowIsInserted) && !preExisting?.has(identityBeforeWrite);

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

/** The row key of `row`, or undefined when the model has none or the row lacks one of its fields */
const completeRowKeyOf = (row: Row, keyFields: readonly string[] | undefined): Row | undefined =>
  !keyFields || keyFields.some((field) => row[field] === undefined || row[field] === null)
    ? undefined
    : rowKeyOf(row, keyFields);

/**
 * How the rows `operation` writes have their row key written. The rows of an `updateMany` are not
 * told apart by element, so when it has several elements and one writes the key, which rows each
 * wrote is unknown and so is the key of every row.
 */
const batchKeyWriteOf = (writes: readonly RowKeyWrite[]): RowKeyWrite => {
  const writing = writes.filter((write) => write.kind !== 'none');
  if (writing.length === 0) {
    return NO_ROW_KEY_WRITE;
  }
  return writes.length === 1 && writing[0] ? writing[0] : { kind: 'not-derivable' };
};

const locatorOf = (key: Row | undefined, where: Row, keyWrite: RowKeyWrite): NestedRowLocator => {
  if (!key) {
    return { by: 'uniqueWhere', where };
  }
  return keyWrite.kind === 'not-derivable' ? { by: 'unknown' } : { by: 'rowKey', where: withWrittenKey(key, keyWrite) };
};

interface TargetContext {
  readonly schemaMetadata: SchemaMetadata;
  readonly nestedPreFetchResults: NestedPreFetchResults;
  readonly batchTargets: NestedBatchTargets;
  readonly keyConstraint: UniqueConstraint | undefined;
  readonly prisma: PrismaValues;
}

/** A target with the row key it names before the write and the one it has after it, when both are known */
interface KeyedTarget {
  readonly target: NestedWriteTarget;
  readonly keys: { readonly named: Row; readonly written: Row } | undefined;
}

const keyedTarget = (target: NestedWriteTarget, named: Row | undefined, keyWrite: RowKeyWrite): KeyedTarget => ({
  target,
  keys: named && keyWrite.kind !== 'not-derivable' ? { named, written: withWrittenKey(named, keyWrite) } : undefined,
});

const targetsOf = (operation: NestedOperationInfo, context: TargetContext): KeyedTarget[] => {
  const { nestedPreFetchResults, keyConstraint } = context;
  const keyWrites = updateDataOf(operation).map((data) =>
    rowKeyWriteOf(context.schemaMetadata, operation.relatedModel, data, context.prisma),
  );
  if (isNestedBatchKeyword(operation.operation)) {
    const matched = context.batchTargets.get(operation.path)?.get(operation.operation)?.values() ?? [];
    const keyWrite = batchKeyWriteOf(keyWrites);
    return Array.from(matched, (key) =>
      keyedTarget(
        {
          locator: locatorOf(key, key, keyWrite),
          operation,
          element: undefined,
          before: preFetchedStateNamedBy(nestedPreFetchResults, operation.path, key),
        },
        key,
        keyWrite,
      ),
    );
  }
  return namedTargets(operation.operation, operation.data).map(({ element, where }) => {
    const before = preFetchedStateNamedBy(nestedPreFetchResults, operation.path, where);
    // The update branch of an upsert runs only on a row the read found
    const keyWrite =
      operation.operation === 'upsert' && before.kind !== 'captured'
        ? NO_ROW_KEY_WRITE
        : (keyWrites[element] ?? NO_ROW_KEY_WRITE);
    const readKey = before.kind === 'captured' ? completeRowKeyOf(before.row, keyConstraint?.fields) : undefined;
    const namedKey = keyConstraint ? rowKeyNamedBy(where, keyConstraint) : undefined;
    const locatedKey = readKey ?? (keyWrite.kind !== 'none' && operation.operation === 'update' ? namedKey : undefined);
    const target = { locator: locatorOf(locatedKey, where, keyWrite), operation, element, before };
    return keyedTarget(target, readKey ?? namedKey, keyWrite);
  });
};

/** The keywords whose targets are rows that exist before the write and are located after it */
const LOCATED_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set([
  'update',
  'updateMany',
  'upsert',
  'connect',
  'set',
  'connectOrCreate',
]);

/** The keywords that name rows anywhere, not only among the rows the relation holds under the parent */
const LINKING_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set(['connect', 'set', 'connectOrCreate']);

/** The keys of a target that exists before the write, compared to tell it from the other targets at its path */
interface ComparedKeys {
  readonly target: NestedWriteTarget;
  /** The row it names before the write */
  readonly named: string;
  /** The row it is located by after the write, under its parent row */
  readonly written: string;
  /** The row it names, under its parent row; undefined for a write that names a row anywhere */
  readonly namedUnderParent: string | undefined;
  /** Its write may give its row another key: one a write of its data gives, or a parent a link gives */
  readonly rewritesKey: boolean;
}

/**
 * Keys compared under one parent row: with a key link, the parent row stands in for the
 * foreign-key fields of the key, whose values after the write only the parent row tells
 */
interface KeyComparison {
  readonly keyFields: readonly string[];
  readonly keyLink: KeyLink | undefined;
  readonly schemaMetadata: SchemaMetadata;
  readonly nestedPreFetchResults: NestedPreFetchResults;
}

const parentTokenOf = (operation: NestedOperationInfo, comparison: KeyComparison): string => {
  const identity = parentRowIdentityOf(operation.parent, comparison.nestedPreFetchResults, comparison.schemaMetadata);
  if (identity === TOP_LEVEL_ROW) {
    return 'top';
  }
  return typeof identity === 'string' ? `row:${identity}` : 'unknown';
};

const resolvedIdentityOf = (key: Row, keyFields: readonly string[]): string | undefined => {
  const identity = extractEntityIdentity(key, keyFields);
  return typeof identity === 'string' ? identity : undefined;
};

const keyUnderParent = (key: Row, operation: NestedOperationInfo, comparison: KeyComparison): string | undefined => {
  const { keyLink, keyFields } = comparison;
  if (!keyLink) {
    return resolvedIdentityOf(key, keyFields);
  }
  const fields = keyFields.filter((field) => !keyLink.fields.includes(field));
  const identity = resolvedIdentityOf(withoutKeyLink(key, keyLink), fields);
  return identity === undefined ? undefined : JSON.stringify([parentTokenOf(operation, comparison), identity]);
};

const comparedKeysOf = (keyed: KeyedTarget, comparison: KeyComparison): ComparedKeys | undefined => {
  const { target, keys } = keyed;
  const { operation } = target.operation;
  const existsBefore = (operation !== 'upsert' && operation !== 'connectOrCreate') || target.before.kind === 'captured';
  if (!keys || !isLocated(target) || !LOCATED_KEYWORDS.has(operation) || !existsBefore) {
    return undefined;
  }
  const named = resolvedIdentityOf(keys.named, comparison.keyFields);
  const written = keyUnderParent(keys.written, target.operation, comparison);
  if (named === undefined || written === undefined) {
    return undefined;
  }
  const linking = LINKING_KEYWORDS.has(operation);
  const namedUnderParent = linking ? undefined : keyUnderParent(keys.named, target.operation, comparison);
  return {
    target,
    named,
    written,
    namedUnderParent,
    rewritesKey: linking ? comparison.keyLink !== undefined : namedUnderParent !== written,
  };
};

/**
 * The targets at a path that cannot be told apart by key: targets that name different rows but are
 * located by the same key after the write, and a target that names the key another target's write
 * gives a row, with that target
 */
const indistinguishableTargets = (keyed: readonly KeyedTarget[], comparison: KeyComparison): Set<NestedWriteTarget> => {
  const compared = keyed.flatMap((entry) => comparedKeysOf(entry, comparison) ?? []);
  const indistinguishable = new Set<NestedWriteTarget>();
  for (const left of compared) {
    for (const right of compared) {
      if (left === right || left.named === right.named) {
        continue;
      }
      const sameWrittenKey = left.written === right.written;
      const namesWrittenKey = right.rewritesKey && left.namedUnderParent === right.written;
      if (sameWrittenKey || namesWrittenKey) {
        indistinguishable.add(left.target);
        indistinguishable.add(right.target);
      }
    }
  }
  return indistinguishable;
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
  readonly keyed: KeyedTarget[];
  readonly generatedKeys: Set<EntityIdentityKey>;
  readonly withoutGeneratedKey: Map<NestedOperationInfo, number>;
  /** A write at the path gives a row another key than the one the extension generated for it */
  writesKey: boolean;
  readsPreExisting: boolean;
  comparison: KeyComparison | undefined;
}

/**
 * Whether `operation` writes a key field of the rows it updates, which can give a row the
 * operations at the path insert another key than the one the extension generated for it
 */
const writesKeyField = (operation: NestedOperationInfo, keyFields: readonly string[] | undefined): boolean =>
  keyFields !== undefined &&
  updateDataOf(operation).some((data) => isRecord(data) && keyFields.some((field) => data[field] !== undefined));

/** Records in `writeSet` the key of each row `operation` inserts that the extension generated, else that the operation inserts a row without one */
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
      writeSet.withoutGeneratedKey.set(operation, (writeSet.withoutGeneratedKey.get(operation) ?? 0) + 1);
    }
  }
  writeSet.readsPreExisting =
    writeSet.readsPreExisting ||
    writeSet.withoutGeneratedKey.size > 0 ||
    (inserted.length > 0 && skipsDuplicates(operation));
};

const UNKNOWN_LOCATOR: NestedRowLocator = { by: 'unknown' };

const finishedWriteSet = (draft: WriteSetDraft): NestedWriteSet => {
  const indistinguishable = draft.comparison ? indistinguishableTargets(draft.keyed, draft.comparison) : new Set();
  const targets = draft.keyed.map(({ target }) =>
    indistinguishable.has(target) ? { ...target, locator: UNKNOWN_LOCATOR } : target,
  );
  const followsEveryTarget = targets.every(isLocated);
  return {
    targets,
    generatedKeys: draft.generatedKeys,
    anyNewRowIsInserted: followsEveryTarget && (draft.withoutGeneratedKey.size > 0 || draft.writesKey),
    unidentifiedInserts: followsEveryTarget ? new Map() : draft.withoutGeneratedKey,
    readsPreExisting: draft.readsPreExisting,
  };
};

/**
 * @param modelName - The top-level model the operations are nested under
 * @param rowsWithGeneratedKeys - The data of each row the operations insert whose key the extension
 *   generated (`withInsertedRowKeys`)
 * @param prisma - The client's Prisma namespace, which an update's data is read with
 *   (`rowKeyWriteOf`)
 */
export const buildNestedWriteSets = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operations: readonly NestedOperationInfo[],
  rowsWithGeneratedKeys: ReadonlySet<object>,
  nestedPreFetchResults: NestedPreFetchResults,
  batchTargets: NestedBatchTargets,
  prisma: PrismaValues,
): NestedWriteSets => {
  const writeSets = new Map<string, WriteSetDraft>();

  for (const operation of operations) {
    if (!operation.isList) {
      continue;
    }
    const keyConstraint = getRowKeyConstraint(schemaMetadata, operation.relatedModel);
    const writeSet: WriteSetDraft = writeSets.get(operation.path) ?? {
      keyed: [],
      generatedKeys: new Set(),
      withoutGeneratedKey: new Map(),
      writesKey: false,
      readsPreExisting: false,
      comparison: keyConstraint && {
        keyFields: keyConstraint.fields,
        keyLink: keyLinkOf(schemaMetadata, modelName, operation),
        schemaMetadata,
        nestedPreFetchResults,
      },
    };
    writeSets.set(operation.path, writeSet);

    const keyed = targetsOf(operation, {
      schemaMetadata,
      nestedPreFetchResults,
      batchTargets,
      keyConstraint,
      prisma,
    });
    writeSet.keyed.push(...keyed);

    addInsertedRows(
      writeSet,
      operation,
      rowsInsertedBy(
        operation,
        keyed.map(({ target }) => target),
      ),
      rowsWithGeneratedKeys,
      keyConstraint?.fields,
    );
    if (writesKeyField(operation, keyConstraint?.fields)) {
      writeSet.writesKey = true;
      writeSet.readsPreExisting = true;
    }
  }

  return new Map(Array.from(writeSets, ([path, draft]) => [path, finishedWriteSet(draft)]));
};
