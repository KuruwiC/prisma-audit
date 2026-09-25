/**
 * One-to-Many Relation Pre-fetch Module
 *
 * Captures the before-state of the rows a nested `update` / `upsert` / `delete` on a to-many
 * relation targets. Prisma applies such an operation only to a row related to the parent row, so
 * a row that matches the unique WHERE under another parent is not its target.
 *
 * @module lifecycle/pre-fetch/one-to-many-fetcher
 */

import { preFetchLog } from '@kuruwic/prisma-audit-core';
import type { DMMFField, DMMFModel } from '../../internal-types.js';
import type { UniqueConstraint } from '../../schema/types.js';
import type { PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { type ResolveParentRowsInput, resolveParentRows, targetWhereClauses } from './parent-rows.js';
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

export interface PreFetchOneToManyRelationInput extends Omit<ResolveParentRowsInput, 'parentFields'> {
  operation: string;
  data: unknown;
  scope: ToManyRelationScope;
  relatedModelClient: PreFetchModelClient;
  /** The related model's primary key (fields + DMMF name) */
  pkConstraint: UniqueConstraint;
  /** Parent keys named by the WHERE of parent-path operations that were not pre-fetched */
  parentKeysFromWhere: readonly PreFetchRecord[];
}

/**
 * Pre-fetches the row each target WHERE of a nested to-many `update` / `upsert` / `delete` names
 * under one of its parent rows.
 *
 * The WHERE is a `<Model>WhereUniqueInput`, so it goes to `findUnique` with the back-relation
 * filter added under `AND` — including Prisma's compound-unique shape for composite primary keys
 * (`{ a_b: { a, b } }`, or a custom name from `@@id([a, b], name: "custom")`). Only entityId
 * derivation unwraps that shape (see `extractEntityId`). Parent rows are tried in turn until one
 * holds the row; when no parent row exists, nothing is queried or stored.
 */
export const preFetchOneToManyRelation = async (input: PreFetchOneToManyRelationInput): Promise<void> => {
  const { path, operation, data, scope, relatedModelClient, pkConstraint, parentKeysFromWhere, preFetchResults } =
    input;

  const whereClauses = targetWhereClauses(operation, data);
  if (whereClauses.length === 0) {
    preFetchLog('1:N no target where clause: path=%s operation=%s', path, operation);
    return;
  }

  const parentRows = [
    ...(await resolveParentRows({ ...input, parentFields: scope.parentFields })),
    ...parentKeysFromWhere,
  ];
  preFetchLog('1:N parent rows: path=%s count=%d', path, parentRows.length);

  if (parentRows.length === 0) {
    return;
  }

  for (const where of whereClauses) {
    let beforeRecord: PreFetchRecord | null = null;

    for (const parentRow of parentRows) {
      const parentKey = Object.fromEntries(scope.parentFields.map((fieldName) => [fieldName, parentRow[fieldName]]));
      if (Object.values(parentKey).some((value) => value === null || value === undefined)) {
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
