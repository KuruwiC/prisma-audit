/**
 * One-to-Many Relation Pre-fetch Module
 *
 * Captures the before-state of the rows a nested write on a to-many relation targets: the row
 * each unique WHERE of an `update` / `upsert` / `delete` names, and the rows the filter of an
 * `updateMany` / `deleteMany` matches. Prisma applies such an operation only to rows related to
 * the parent row, so a row that matches under another parent is not its target.
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
import type { RelationField, SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { uniqueWhereAsFilter } from '../../utils/compound-where.js';
import { preFetchLog } from '../../utils/debug.js';
import { extractEntityIdentity, primaryKeyOf } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';
import type { PreFetchListClient, PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { parentKeyOf, type ResolveParentRowsInput, resolveParentRows } from './parent-rows.js';
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
 * identified by its primary key.
 *
 * @throws Error when the relation has no back-relation field
 */
export const resolveToManyRelationScope = (
  schemaMetadata: SchemaMetadata,
  field: RelationField,
  parentModelName: string,
  parentPkFields: readonly string[],
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
    parentFields: parentPkFields,
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
  /** The related model's primary key (fields + the name the schema gives it) */
  pkConstraint: UniqueConstraint;
}

interface ScopedParentRows {
  readonly rows: readonly PreFetchRecord[];
  readonly allKnown: boolean;
}

const resolveScopedParentRows = async (input: ToManyScopeInput): Promise<ScopedParentRows> => {
  const { rows, allKnown } = await resolveParentRows({ ...input, parentFields: input.scope.parentFields });
  return { rows: rows.map((parent) => parent.row), allKnown };
};

export interface PreFetchOneToManyRelationInput extends ToManyScopeInput {
  operation: NestedOperationKeyword;
  relatedModelClient: PreFetchModelClient;
  onTargetReadFailure: TargetReadFailureHandler;
}

/** Reads the row `where` names under each parent row in turn until one holds it */
const readTargetUnderParents = async (
  input: PreFetchOneToManyRelationInput,
  where: PreFetchRecord,
  parentRows: readonly PreFetchRecord[],
): Promise<PreFetchRecord | null> => {
  const { path, scope, relatedModelClient } = input;
  for (const parentRow of parentRows) {
    const parentKey = parentKeyOf(parentRow, scope.parentFields);
    if (!parentKey) {
      continue;
    }

    const scopedWhere = scopeWhereToParent(where, scope, parentKey);
    preFetchLog('1:N scoped where: path=%s where=%O', path, scopedWhere);

    const beforeRecord = await relatedModelClient.findUnique({ where: scopedWhere });
    if (beforeRecord) {
      return beforeRecord;
    }
  }
  return null;
};

/**
 * Pre-fetches the row each target WHERE of a nested to-many `update` / `upsert` / `delete` names
 * under one of its parent rows.
 *
 * The WHERE is a `<Model>WhereUniqueInput`, so it goes to `findUnique` with the back-relation
 * filter added under `AND` — including Prisma's compound-unique shape for composite primary keys
 * (`{ a_b: { a, b } }`, or a custom name from `@@id([a, b], name: "custom")`). Entity-identity
 * derivation and `matchesUniqueWhere` unwrap that shape. Parent rows are tried in turn until one
 * holds the row; when no parent row exists, nothing is queried or stored. When a parent row could
 * not be read and is not known by its key, a row no known parent holds is stored as unavailable.
 * Each target is read on its own: a failed read goes to `onTargetReadFailure` and the next target
 * is still read.
 *
 * @throws The error of a failed read of the parent rows, before any target is read
 */
export const preFetchOneToManyRelation = async (input: PreFetchOneToManyRelationInput): Promise<void> => {
  const { path, operation, data, pkConstraint, preFetchResults, onTargetReadFailure } = input;

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
      const beforeRecord = await readTargetUnderParents(input, where, parentRows);
      storeReadResult(preFetchResults, path, where, beforeRecord, pkConstraint, allKnown);
      preFetchLog('1:N stored: path=%s found=%s', path, beforeRecord !== null);
    },
    onTargetReadFailure,
  );
};

export interface PreFetchToManyBatchInput extends ToManyScopeInput {
  operation: NestedBatchKeyword;
  relatedModelClient: PreFetchListClient;
  /** Whether the matched rows are read whole, as their before-state, or by primary key only */
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
  pkFields: readonly string[],
): void => {
  const name = { by: 'batchFilter' } as const;
  if (fetchBefore) {
    storePreFetchResult(preFetchResults, path, { before: { kind: 'captured', row }, identity, name });
  } else if (!preFetchedResultFor(preFetchResults, path, identity)) {
    storePreFetchResult(preFetchResults, path, {
      before: NO_BEFORE_STATE,
      identity,
      name,
      key: primaryKeyOf(row, pkFields),
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
  const { scope, precedingWrites, fieldNames, pkConstraint } = input;
  // Prisma reads an empty `OR` nested under `AND` as no condition, so a `set` naming no row keeps
  // no row through a primary-key `in` with no values
  const noRow = { [pkConstraint.fields[0] ?? '']: { in: [] } };
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
 * `fetchBefore` asks for its before-state, else by its primary key with none.
 *
 * @returns The primary key of every matched row, keyed by its identity
 * @throws Error when a parent row could not be read and is not known by its key: the rows the
 *   filter matches under it cannot be identified
 */
export const preFetchToManyBatch = async (
  input: PreFetchToManyBatchInput,
): Promise<Map<EntityIdentityKey, PreFetchRecord>> => {
  const { path, operation, data, relatedModelClient, pkConstraint, fetchBefore, preFetchResults } = input;

  const { rows: parentRows, allKnown } = await resolveScopedParentRows(input);
  if (!allKnown) {
    throw new Error(
      `[@prisma-audit] Cannot identify the rows the ${operation} at nested path "${path}" writes: ` +
        'a row it is nested under could not be read',
    );
  }
  const wheres = batchFilterClauses(operation, data).flatMap((filter) =>
    scopeFilterToParents(filter, input, parentRows),
  );
  preFetchLog('1:N batch parent rows: path=%s operation=%s queries=%d', path, operation, wheres.length);

  const select: Record<string, true> = Object.fromEntries(pkConstraint.fields.map((fieldName) => [fieldName, true]));
  const matched = new Map<EntityIdentityKey, PreFetchRecord>();

  for (const where of wheres) {
    const rows = await relatedModelClient.findMany(fetchBefore ? { where } : { where, select });
    for (const row of rows) {
      const identity = extractEntityIdentity(row, pkConstraint.fields);
      if (identity === UNRESOLVED_ENTITY_ID) {
        continue;
      }
      matched.set(identity, primaryKeyOf(row, pkConstraint.fields));
      storeMatchedRow(preFetchResults, path, identity, row, fetchBefore, pkConstraint.fields);
    }
  }

  preFetchLog('1:N batch stored: path=%s operation=%s rows=%d', path, operation, matched.size);
  return matched;
};
