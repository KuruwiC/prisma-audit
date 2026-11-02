/**
 * One-to-Many Relation Pre-fetch Module
 *
 * Captures the before-state of the rows a nested write on a to-many relation targets: the row
 * each unique WHERE of an `update` / `upsert` / `delete` names, and the rows the filter of an
 * `updateMany` / `deleteMany` matches. Prisma applies such an operation only to rows related to
 * the parent row, so a row that matches under another parent is not its target.
 *
 * Prisma writes the parent row before the writes nested in it, so a unique WHERE names the
 * foreign-key fields of the row key (`nested/key-link`) by the parent's referenced columns as the
 * parent's write leaves them. The read ahead of the write names them by the parent's columns
 * before it: the row the WHERE names after the parent's write held those before it.
 *
 * @module nested/pre-fetch/one-to-many-fetcher
 */

import {
  batchFilterClauses,
  type NestedBatchKeyword,
  type NestedOperationKeyword,
  namedTargets,
  type PrecedingNestedWrite,
} from '../../grammar/nested-operations.js';
import type { ParentRowIdentity } from '../../grammar/nested-state.js';
import type { RelationField, SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { compoundWhereKeyOf, uniqueWhereAsFilter, unwrapCompoundWhere } from '../../utils/compound-where.js';
import { preFetchLog } from '../../utils/debug.js';
import { extractEntityIdentity, rowKeyOf, sameKeyValue } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';
import type { RowKeyWrite } from '../../utils/row-key-write.js';
import { type KeyLink, keyLinkValuesOf } from '../key-link.js';
import type { PreFetchListClient, PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { type ParentRow, parentKeyOf, type ResolveParentRowsInput, resolveParentRows } from './parent-rows.js';
import { preFetchedResultFor, storePreFetchResult, storeReadResult } from './pre-fetch-result-store.js';
import { findBackRelationField } from './relation-link.js';
import { readEachTarget, type TargetReadFailureHandler } from './target-reads.js';

/** A related row belongs to the parent row when `backField` matches the parent's `parentFields`. */
export interface ToManyRelationScope {
  readonly backField: string;
  /** `some` when the back field is a list (implicit many-to-many), else `is` */
  readonly filter: 'is' | 'some';
  readonly parentFields: readonly string[];
  /**
   * The related row's foreign-key `fields` and the parent `references` they hold, in the same
   * order; absent for an implicit many-to-many relation
   */
  readonly foreignKey?: { readonly fields: readonly string[]; readonly references: readonly string[] };
}

/**
 * Resolves the scope of `field`, a to-many relation field declared on `parentModelName`: the
 * related model's field with the same `relationName` points back to the parent, which is
 * identified by its row key.
 *
 * @throws Error when the relation has no back-relation field
 */
export const resolveToManyRelationScope = (
  schemaMetadata: SchemaMetadata,
  field: RelationField,
  parentModelName: string,
  parentKeyFields: readonly string[],
): ToManyRelationScope => {
  const { relationName } = field;
  const backField = findBackRelationField(
    field,
    parentModelName,
    field.relatedModel,
    schemaMetadata.getRelationFields(field.relatedModel),
  );
  if (!backField) {
    throw new Error(
      `[@prisma-audit] Relation "${relationName}" has no back-relation field on model "${field.relatedModel}"`,
    );
  }

  const foreignKey =
    backField.foreignKeyFields.length > 0
      ? { fields: backField.foreignKeyFields, references: backField.referencedFields }
      : undefined;
  return {
    backField: backField.name,
    filter: backField.isList ? 'some' : 'is',
    parentFields: parentKeyFields,
    ...(foreignKey ? { foreignKey } : {}),
  };
};

const relatedToParent = (scope: ToManyRelationScope, parentKey: PreFetchRecord): PreFetchRecord => ({
  [scope.backField]: { [scope.filter]: parentKey },
});

const andWhere = (where: PreFetchRecord, condition: PreFetchRecord): PreFetchRecord => {
  const existingAnd = where.AND;
  const and = existingAnd === undefined ? [] : Array.isArray(existingAnd) ? existingAnd : [existingAnd];
  return { ...where, AND: [...and, condition] };
};

const scopeWhereToParent = (
  where: PreFetchRecord,
  scope: ToManyRelationScope,
  parentKey: PreFetchRecord,
): PreFetchRecord => andWhere(where, relatedToParent(scope, parentKey));

export interface ToManyScopeInput extends Omit<ResolveParentRowsInput, 'parentFields'> {
  data: unknown;
  scope: ToManyRelationScope;
  /** The related model's row key (fields + the name the schema gives it) */
  keyConstraint: UniqueConstraint;
}

interface ScopedParentRows {
  readonly rows: readonly ParentRow[];
  readonly allKnown: boolean;
}

const resolveScopedParentRows = (input: ToManyScopeInput): Promise<ScopedParentRows> =>
  resolveParentRows({ ...input, parentFields: input.scope.parentFields });

/**
 * How the write of the parent row an operation is nested under writes the columns the foreign-key
 * fields of the related row key reference
 */
export interface ParentKeyLinkWrite {
  /** The identity of that parent row before the write; undefined when unknown */
  readonly parent: ParentRowIdentity | undefined;
  readonly link: KeyLink;
  /** How the parent's data writes `link.references` */
  readonly write: RowKeyWrite;
}

export interface PreFetchOneToManyRelationInput extends ToManyScopeInput {
  operation: NestedOperationKeyword;
  relatedModelClient: PreFetchModelClient;
  onTargetReadFailure: TargetReadFailureHandler;
  /** Undefined when the related row key holds no foreign key to the parent */
  parentKeyLinkWrite?: ParentKeyLinkWrite;
}

/**
 * What `where` names under `parent` before the parent's write: itself; another WHERE, its
 * foreign-key fields of the row key given the values the parent held before the write; no row,
 * when it names those fields by values the parent does not hold after the write; or a row that
 * cannot be told, when the parent's data writes those columns in a way its arguments do not tell
 * or the parent's columns before the write are unknown
 */
type NamedBeforeParentWrite =
  | { readonly kind: 'where'; readonly where: PreFetchRecord }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

const namedBeforeParentWrite = (
  input: PreFetchOneToManyRelationInput,
  where: PreFetchRecord,
  parent: ParentRow,
): NamedBeforeParentWrite => {
  const { parentKeyLinkWrite: linkWrite, keyConstraint } = input;
  if (
    !linkWrite ||
    linkWrite.write.kind === 'none' ||
    (linkWrite.parent !== undefined && linkWrite.parent !== parent.identity)
  ) {
    return { kind: 'where', where };
  }
  const flat = unwrapCompoundWhere(where, keyConstraint);
  const named = linkWrite.link.fields.filter((field) => field in flat);
  if (named.length === 0) {
    return { kind: 'where', where };
  }
  const before = keyLinkValuesOf(linkWrite.link, parent.row);
  if (linkWrite.write.kind === 'not-derivable' || linkWrite.parent === undefined || !before) {
    return { kind: 'unknown' };
  }
  const after = keyLinkValuesOf(linkWrite.link, { ...parent.row, ...linkWrite.write.values });
  if (!after || named.some((field) => !sameKeyValue(flat[field], after[field]))) {
    return { kind: 'none' };
  }
  const values = { ...flat, ...Object.fromEntries(named.map((field) => [field, before[field]])) };
  // A compound key is named through its wrapper, the only shape a `WhereUniqueInput` takes it in
  return {
    kind: 'where',
    where: flat === where ? values : { ...where, [compoundWhereKeyOf(keyConstraint)]: values },
  };
};

interface TargetRead {
  readonly record: PreFetchRecord | null;
  /** A parent row the WHERE may name a row under, whose row cannot be told */
  readonly untold: boolean;
}

/** Reads the row `where` names under each parent row in turn until one holds it */
const readTargetUnderParents = async (
  input: PreFetchOneToManyRelationInput,
  where: PreFetchRecord,
  parentRows: readonly ParentRow[],
): Promise<TargetRead> => {
  const { path, scope, relatedModelClient } = input;
  let untold = false;
  for (const parent of parentRows) {
    const parentKey = parentKeyOf(parent.row, scope.parentFields);
    const named = namedBeforeParentWrite(input, where, parent);
    untold = untold || named.kind === 'unknown';
    if (!parentKey || named.kind !== 'where') {
      continue;
    }

    const scopedWhere = scopeWhereToParent(named.where, scope, parentKey);
    preFetchLog('1:N scoped where: path=%s where=%O', path, scopedWhere);

    const beforeRecord = await relatedModelClient.findUnique({ where: scopedWhere });
    if (beforeRecord) {
      return { record: beforeRecord, untold: false };
    }
  }
  return { record: null, untold };
};

/**
 * Pre-fetches the row each target WHERE of a nested to-many `update` / `upsert` / `delete` names
 * under one of its parent rows.
 *
 * The WHERE is a `<Model>WhereUniqueInput`, so it goes to `findUnique` with the back-relation
 * filter added under `AND` — including Prisma's compound-unique shape for composite row keys
 * (`{ a_b: { a, b } }`, or a custom name from `@@id([a, b], name: "custom")`). Entity-identity
 * derivation and `matchesUniqueWhere` unwrap that shape. Parent rows are tried in turn until one
 * holds the row; when no parent row exists, nothing is queried or stored. When a parent row could
 * not be read and is not known by its key, or the row a WHERE names under a parent row cannot be
 * told before the parent's write, a row no known parent holds is stored as unavailable.
 * Each target is read on its own: a failed read goes to `onTargetReadFailure` and the next target
 * is still read.
 *
 * @throws The error of a failed read of the parent rows, before any target is read
 */
export const preFetchOneToManyRelation = async (input: PreFetchOneToManyRelationInput): Promise<void> => {
  const { path, operation, data, keyConstraint, preFetchResults, onTargetReadFailure } = input;

  const targets = namedTargets(operation, data);
  if (targets.length === 0) {
    preFetchLog('1:N no target where clause: path=%s operation=%s', path, operation);
    return;
  }

  const { rows: parentRows, allKnown } = await resolveScopedParentRows(input);
  preFetchLog('1:N parent rows: path=%s count=%d allKnown=%s', path, parentRows.length, allKnown);

  if (parentRows.length === 0 && allKnown) {
    return;
  }

  await readEachTarget(
    targets,
    async (where) => {
      const { record, untold } = await readTargetUnderParents(input, where, parentRows);
      storeReadResult(preFetchResults, path, where, record, keyConstraint, allKnown && !untold);
      preFetchLog('1:N stored: path=%s found=%s', path, record !== null);
    },
    onTargetReadFailure,
  );
};

export interface PreFetchToManyBatchInput extends ToManyScopeInput {
  operation: NestedBatchKeyword;
  relatedModelClient: PreFetchListClient;
  /** Whether the matched rows are read whole, as their before-state, or by row key only */
  fetchBefore: boolean;
  /** The writes to the relation that run before the operation (see `NestedOperationInfo.precedingWrites`) */
  precedingWrites: readonly PrecedingNestedWrite[];
  /** The related model's field names, to turn a unique WHERE into a filter */
  fieldNames: ReadonlySet<string>;
}

/** An identity-only read never replaces what another operation at the path already read */
const storeMatchedRow = (
  preFetchResults: PreFetchToManyBatchInput['preFetchResults'],
  path: string,
  identity: EntityIdentityKey,
  row: PreFetchRecord,
  fetchBefore: boolean,
  keyFields: readonly string[],
): void => {
  const name = { by: 'batchFilter' } as const;
  if (fetchBefore) {
    storePreFetchResult(preFetchResults, path, { before: { kind: 'captured', row }, identity, name });
  } else if (!preFetchedResultFor(preFetchResults, path, identity)) {
    storePreFetchResult(preFetchResults, path, {
      before: NO_BEFORE_STATE,
      identity,
      name,
      key: rowKeyOf(row, keyFields),
    });
  }
};

/**
 * The filter of the rows related to the parent row `parentKey` when a batch keyword runs: the rows
 * related to it before the write, then, keyword by keyword in the order the writes before it run,
 * with the rows a `connect` or `connectOrCreate` names added, the rows a `disconnect` or `delete`
 * names removed, and only the rows a `set` names kept. Rows a write inserts are unknown before the
 * write and are not included, and filters match the rows as they were before the write.
 */
const whereRelatedWhenRun = (input: PreFetchToManyBatchInput, parentKey: PreFetchRecord): PreFetchRecord => {
  const { scope, precedingWrites, fieldNames, keyConstraint } = input;
  // Prisma reads an empty `OR` nested under `AND` as no condition, so a `set` naming no row keeps
  // no row through a row-key `in` with no values
  const noRow = { [keyConstraint.fields[0] ?? '']: { in: [] } };
  return precedingWrites.reduce<PreFetchRecord>(
    (related, { operation, data }) => {
      const named = namedTargets(operation, data).map(({ where }) => uniqueWhereAsFilter(where, fieldNames));
      switch (operation) {
        case 'connect':
        case 'connectOrCreate':
          return named.length === 0 ? related : { OR: [related, ...named] };
        case 'set':
          return named.length === 0 ? noRow : { OR: named };
        case 'disconnect':
        case 'delete':
          return named.length === 0 ? related : { AND: [related, { NOT: { OR: named } }] };
        default:
          return related;
      }
    },
    relatedToParent(scope, parentKey),
  );
};

const scopeFilterToParents = (
  filter: PreFetchRecord,
  input: PreFetchToManyBatchInput,
  parentRows: readonly PreFetchRecord[],
): PreFetchRecord[] =>
  parentRows.flatMap((parentRow) => {
    const parentKey = parentKeyOf(parentRow, input.scope.parentFields);
    return parentKey ? [andWhere(filter, whereRelatedWhenRun(input, parentKey))] : [];
  });

/**
 * Pre-reads the rows a nested `updateMany` / `deleteMany` filter matches, scoped through the
 * back-relation the way Prisma scopes the write, to the rows related to the parent row when the
 * operation runs (see {@link whereRelatedWhenRun}). Each matched row is stored whole when
 * `fetchBefore` asks for its before-state, else by its row key with none.
 *
 * @returns The row key of every matched row, keyed by its identity
 * @throws Error when a parent row could not be read and is not known by its key: the rows the
 *   filter matches under it cannot be identified
 */
export const preFetchToManyBatch = async (
  input: PreFetchToManyBatchInput,
): Promise<Map<EntityIdentityKey, PreFetchRecord>> => {
  const { path, operation, data, relatedModelClient, keyConstraint, fetchBefore, preFetchResults } = input;

  const { rows: parentRows, allKnown } = await resolveScopedParentRows(input);
  if (!allKnown) {
    throw new Error(
      `[@prisma-audit] Cannot identify the rows the ${operation} at nested path "${path}" writes: ` +
        'a row it is nested under could not be read',
    );
  }
  const wheres = batchFilterClauses(operation, data).flatMap((filter) =>
    scopeFilterToParents(
      filter,
      input,
      parentRows.map((parent) => parent.row),
    ),
  );
  preFetchLog('1:N batch parent rows: path=%s operation=%s queries=%d', path, operation, wheres.length);

  const select: Record<string, true> = Object.fromEntries(keyConstraint.fields.map((fieldName) => [fieldName, true]));
  const matched = new Map<EntityIdentityKey, PreFetchRecord>();

  for (const where of wheres) {
    const rows = await relatedModelClient.findMany(fetchBefore ? { where } : { where, select });
    for (const row of rows) {
      const identity = extractEntityIdentity(row, keyConstraint.fields);
      if (identity === UNRESOLVED_ENTITY_ID) {
        continue;
      }
      matched.set(identity, rowKeyOf(row, keyConstraint.fields));
      storeMatchedRow(preFetchResults, path, identity, row, fetchBefore, keyConstraint.fields);
    }
  }

  preFetchLog('1:N batch stored: path=%s operation=%s rows=%d', path, operation, matched.size);
  return matched;
};
