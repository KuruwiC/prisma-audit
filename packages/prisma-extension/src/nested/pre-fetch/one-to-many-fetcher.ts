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
  targetWhereClauses,
} from '../../grammar/nested-operations.js';
import type { DMMFField, DMMFModel } from '../../internal-types.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { preFetchLog } from '../../utils/debug.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from './identity-key.js';
import type { PreFetchListClient, PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { parentKeyOf, type ResolveParentRowsInput, resolveParentRows } from './parent-rows.js';
import { extractEntityId, storePreFetchResult } from './pre-fetch-result-store.js';

/** A related row belongs to the parent row when `backField` matches the parent's `parentFields`. */
export interface ToManyRelationScope {
  readonly backField: string;
  /** `some` when the back field is a list (implicit many-to-many), else `is` */
  readonly filter: 'is' | 'some';
  readonly parentFields: readonly string[];
}

/**
 * Resolves the scope of `field`, a to-many relation field declared on `parentModelName`: the
 * related model's field with the same `relationName` points back to the parent, which is
 * identified by its primary key.
 *
 * @throws Error when the DMMF gives no relation name or no back-relation field
 */
export const resolveToManyRelationScope = (
  field: DMMFField,
  parentModelName: string,
  relatedModel: DMMFModel | undefined,
  parentPkFields: readonly string[],
): ToManyRelationScope => {
  const { relationName } = field;
  if (!relationName) {
    throw new Error(`[@prisma-audit] Relation field "${field.name}" has no relation name in the DMMF`);
  }

  const backField = relatedModel?.fields.find(
    (candidate) =>
      candidate.kind === 'object' &&
      candidate.relationName === relationName &&
      !(relatedModel.name === parentModelName && candidate.name === field.name),
  );
  if (!backField) {
    throw new Error(`[@prisma-audit] Relation "${relationName}" has no back-relation field on model "${field.type}"`);
  }

  return { backField: backField.name, filter: backField.isList ? 'some' : 'is', parentFields: parentPkFields };
};

const scopeWhereToParent = (
  where: PreFetchRecord,
  scope: ToManyRelationScope,
  parentKey: PreFetchRecord,
): PreFetchRecord => {
  const existingAnd = where.AND;
  const and = existingAnd === undefined ? [] : Array.isArray(existingAnd) ? existingAnd : [existingAnd];
  return { ...where, AND: [...and, { [scope.backField]: { [scope.filter]: parentKey } }] };
};

export interface ToManyScopeInput extends Omit<ResolveParentRowsInput, 'parentFields'> {
  data: unknown;
  scope: ToManyRelationScope;
  /** The related model's primary key (fields + DMMF name) */
  pkConstraint: UniqueConstraint;
  /** Parent keys named by the WHERE of parent-path operations that were not pre-fetched */
  parentKeysFromWhere: readonly PreFetchRecord[];
}

const resolveScopedParentRows = async (input: ToManyScopeInput): Promise<PreFetchRecord[]> => [
  ...(await resolveParentRows({ ...input, parentFields: input.scope.parentFields })),
  ...input.parentKeysFromWhere,
];

export interface PreFetchOneToManyRelationInput extends ToManyScopeInput {
  operation: NestedOperationKeyword;
  relatedModelClient: PreFetchModelClient;
}

/**
 * Pre-fetches the row each target WHERE of a nested to-many `update` / `upsert` / `delete` names
 * under one of its parent rows.
 *
 * The WHERE is a `<Model>WhereUniqueInput`, so it goes to `findUnique` with the back-relation
 * filter added under `AND` — including Prisma's compound-unique shape for composite primary keys
 * (`{ a_b: { a, b } }`, or a custom name from `@@id([a, b], name: "custom")`). Entity-identity
 * derivation (`extractEntityId`) and `matchesUniqueWhere` unwrap that shape. Parent rows are
 * tried in turn until one holds the row; when no parent row exists, nothing is queried or stored.
 */
export const preFetchOneToManyRelation = async (input: PreFetchOneToManyRelationInput): Promise<void> => {
  const { path, operation, data, scope, relatedModelClient, pkConstraint, preFetchResults } = input;

  const whereClauses = targetWhereClauses(operation, data);
  if (whereClauses.length === 0) {
    preFetchLog('1:N no target where clause: path=%s operation=%s', path, operation);
    return;
  }

  const parentRows = await resolveScopedParentRows(input);
  preFetchLog('1:N parent rows: path=%s count=%d', path, parentRows.length);

  if (parentRows.length === 0) {
    return;
  }

  for (const where of whereClauses) {
    let beforeRecord: PreFetchRecord | null = null;

    for (const parentRow of parentRows) {
      const parentKey = parentKeyOf(parentRow, scope.parentFields);
      if (!parentKey) {
        continue;
      }

      const scopedWhere = scopeWhereToParent(where, scope, parentKey);
      preFetchLog('1:N scoped where: path=%s where=%O', path, scopedWhere);

      beforeRecord = await relatedModelClient.findUnique({ where: scopedWhere });
      if (beforeRecord) {
        break;
      }
    }

    const entityId = extractEntityId(beforeRecord, where, pkConstraint);
    storePreFetchResult(preFetchResults, path, entityId, beforeRecord);

    preFetchLog('1:N stored: path=%s entityId=%s', path, entityId);
  }
};

export interface PreFetchToManyBatchInput extends ToManyScopeInput {
  operation: NestedBatchKeyword;
  relatedModelClient: PreFetchListClient;
  /** Whether the matched rows are read whole, as their before-state, or by primary key only */
  fetchBeforeOperation: boolean;
}

const primaryKeyOf = (row: PreFetchRecord, pkFields: readonly string[]): PreFetchRecord =>
  Object.fromEntries(pkFields.map((fieldName) => [fieldName, row[fieldName]]));

/** An identity-only read (`null`) never replaces a row another operation at the path already read */
const storeMatchedRow = (
  preFetchResults: PreFetchToManyBatchInput['preFetchResults'],
  path: string,
  identity: EntityIdentityKey,
  before: PreFetchRecord | null,
): void => {
  if (before === null && preFetchResults.get(path)?.has(identity)) {
    return;
  }
  storePreFetchResult(preFetchResults, path, identity, before);
};

const scopeFilterToParents = (
  filter: PreFetchRecord,
  scope: ToManyRelationScope,
  parentRows: readonly PreFetchRecord[],
): PreFetchRecord[] =>
  parentRows.flatMap((parentRow) => {
    const parentKey = parentKeyOf(parentRow, scope.parentFields);
    return parentKey ? [scopeWhereToParent(filter, scope, parentKey)] : [];
  });

/**
 * Pre-reads the rows a nested `updateMany` / `deleteMany` filter matches, scoped through the
 * back-relation the way Prisma scopes the write. Each matched row is stored whole when
 * `fetchBeforeOperation` asks for its before-state, else as an identity with a `null` before-state.
 *
 * @returns The primary key of every matched row, keyed by its identity
 */
export const preFetchToManyBatch = async (
  input: PreFetchToManyBatchInput,
): Promise<Map<EntityIdentityKey, PreFetchRecord>> => {
  const { path, operation, data, scope, relatedModelClient, pkConstraint, fetchBeforeOperation, preFetchResults } =
    input;

  const parentRows = await resolveScopedParentRows(input);
  const wheres = batchFilterClauses(operation, data).flatMap((filter) =>
    scopeFilterToParents(filter, scope, parentRows),
  );
  preFetchLog('1:N batch parent rows: path=%s operation=%s queries=%d', path, operation, wheres.length);

  const select: Record<string, true> = Object.fromEntries(pkConstraint.fields.map((fieldName) => [fieldName, true]));
  const matched = new Map<EntityIdentityKey, PreFetchRecord>();

  for (const where of wheres) {
    const rows = await relatedModelClient.findMany(fetchBeforeOperation ? { where } : { where, select });
    for (const row of rows) {
      const identity = extractEntityIdentity(row, pkConstraint.fields);
      if (identity === UNRESOLVED_ENTITY_ID) {
        continue;
      }
      matched.set(identity, primaryKeyOf(row, pkConstraint.fields));
      storeMatchedRow(preFetchResults, path, identity, fetchBeforeOperation ? row : null);
    }
  }

  preFetchLog('1:N batch stored: path=%s operation=%s rows=%d', path, operation, matched.size);
  return matched;
};
