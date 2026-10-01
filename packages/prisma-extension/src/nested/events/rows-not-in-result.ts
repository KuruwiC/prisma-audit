/**
 * Written rows the result does not hold
 *
 * The rows a to-many relation holds in the result are the rows the operation's selection asked
 * for. An update can change the columns its own WHERE names, and the caller's own `where`,
 * `take`, `skip`, `cursor` or `distinct` on the relation keeps its effect, so a row the operation
 * wrote can be missing from the result. Such rows are read once per path after the write:
 *
 * - an updated row the result does not hold is named by its target's locator;
 * - a row inserted under a parent row whose relation the caller restricted is found by reading
 *   the primary keys the relation holds under those parent rows and leaving out the rows it held
 *   before the write (the pre-write snapshot), the rows the result holds, and the rows a target
 *   names.
 *
 * Those rows are then read whole, with the relations the operation writes below them, so the
 * walk continues under them. A failed read rejects: the rows it would return cannot be left out
 * of the audit.
 */

import type { SchemaMetadata } from '../../schema/types.js';
import { matchesUniqueWhere, uniqueWhereAsFilter } from '../../utils/compound-where.js';
import { nestedLog } from '../../utils/debug.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import type { PreFetchListClient } from '../pre-fetch/model-client.js';
import { parentKeyOf } from '../pre-fetch/parent-rows.js';
import type { ToManyPath } from '../pre-fetch/to-many-path.js';
import type { NestedWriteTarget } from './write-set.js';

type Row = Record<string, unknown>;

/** One parent row at a to-many path, as the walk reached it */
export interface ParentAtPath {
  readonly row: Row;
  /** The rows the result holds under it */
  readonly rows: readonly Row[];
  /** The updates nested under it whose row it does not hold */
  readonly absentTargets: readonly NestedWriteTarget[];
  /** The caller restricted the relation's rows under it, and an operation nested under it inserts rows */
  readonly insertsHidden: boolean;
}

export interface RowsNotInResultInput {
  readonly client: PreFetchListClient;
  readonly schemaMetadata: SchemaMetadata;
  readonly relatedModel: string;
  readonly path: string;
  readonly pkFields: readonly string[];
  /** Every target at the path */
  readonly targets: readonly NestedWriteTarget[];
  /** The primary keys the path held before the write; undefined when no row was snapshotted */
  readonly preExisting: ReadonlySet<EntityIdentityKey> | undefined;
  readonly parents: readonly ParentAtPath[];
  /** The relation of the path; resolved only when inserted rows are looked for */
  readonly resolvePath: () => ToManyPath | undefined;
  /** The relations the operation writes below the path */
  readonly include: Row | undefined;
}

const primaryKeyFilter = (row: Row, pkFields: readonly string[]): Row =>
  Object.fromEntries(pkFields.map((field) => [field, row[field]]));

const readHiddenInsertedKeys = async (
  input: RowsNotInResultInput,
  path: ToManyPath,
  parents: readonly ParentAtPath[],
): Promise<Row[]> => {
  const { client, pkFields, targets, preExisting } = input;
  const { scope } = path;
  const parentScopes = parents.flatMap((parent) => {
    const key = parentKeyOf(parent.row, scope.parentFields);
    return key ? [{ [scope.backField]: { [scope.filter]: key } }] : [];
  });
  if (parentScopes.length === 0) {
    return [];
  }
  const select = Object.fromEntries(pkFields.map((field) => [field, true]));
  const keys = await client.findMany({ where: { OR: parentScopes }, select });
  const held = new Set(
    input.parents.flatMap((parent) => parent.rows.map((row) => extractEntityIdentity(row, pkFields))),
  );
  return keys.filter((key) => {
    const identity = extractEntityIdentity(key, pkFields);
    return (
      !held.has(identity) &&
      !preExisting?.has(identity) &&
      !targets.some(
        (target) =>
          target.locator.by === 'primaryKey' && extractEntityIdentity(target.locator.where, pkFields) === identity,
      )
    );
  });
};

const locatorFilter = (target: NestedWriteTarget, fieldNames: ReadonlySet<string>): Row =>
  target.locator.by === 'primaryKey' ? target.locator.where : uniqueWhereAsFilter(target.locator.where, fieldNames);

/** Whether `row` hangs under `parent`, by the foreign key it holds or the back-relation keys read with it */
const hangsUnder = (row: Row, parent: Row, path: ToManyPath): boolean => {
  const { scope } = path;
  if (scope.foreignKey) {
    const { fields, references } = scope.foreignKey;
    return (
      extractEntityIdentity(row, fields) ===
      extractEntityIdentity(
        Object.fromEntries(references.map((field, index) => [fields[index], parent[field]])),
        fields,
      )
    );
  }
  const linked = row[scope.backField];
  const parentIdentity = extractEntityIdentity(parent, scope.parentFields);
  return (
    Array.isArray(linked) &&
    linked.some((link: Row) => extractEntityIdentity(link, scope.parentFields) === parentIdentity)
  );
};

/**
 * The include of the read: the relations written below the path, and, for an implicit
 * many-to-many relation, the keys of the parent rows each inserted row hangs under, which only
 * the join table holds
 */
const includeOf = (input: RowsNotInResultInput, path: ToManyPath | undefined, hidden: readonly ParentAtPath[]) => {
  if (!path || path.scope.foreignKey || hidden.length === 0) {
    return input.include;
  }
  const { backField, parentFields } = path.scope;
  const keys = hidden.flatMap((parent) => parentKeyOf(parent.row, parentFields) ?? []);
  const select = Object.fromEntries(parentFields.map((field) => [field, true]));
  return { ...input.include, [backField]: { where: { OR: keys }, select } };
};

/** The rows each parent at the path wrote that the result does not hold, in the order of `input.parents` */
export const readRowsNotInResult = async (input: RowsNotInResultInput): Promise<Row[][]> => {
  const { client, schemaMetadata, relatedModel, pkFields, parents } = input;
  const hidden = parents.filter((parent) => parent.insertsHidden);
  const path = hidden.length > 0 ? input.resolvePath() : undefined;
  const insertedKeys = path ? await readHiddenInsertedKeys(input, path, hidden) : [];
  const absentTargets = parents.flatMap((parent) => parent.absentTargets);
  if (insertedKeys.length === 0 && absentTargets.length === 0) {
    return parents.map(() => []);
  }

  const fieldNames = new Set(schemaMetadata.getAllFields(relatedModel).map((field) => field.name));
  const filters = [
    ...absentTargets.map((target) => locatorFilter(target, fieldNames)),
    ...insertedKeys.map((key) => primaryKeyFilter(key, pkFields)),
  ];
  const include = includeOf(input, path, insertedKeys.length > 0 ? hidden : []);
  const rows = await client.findMany({ where: { OR: filters }, ...(include ? { include } : {}) });
  nestedLog('read %d rows the result does not hold at path=%s', rows.length, input.path);

  const inserted = new Set(insertedKeys.map((key) => extractEntityIdentity(key, pkFields)));
  return parents.map((parent) =>
    rows.flatMap((row) => {
      const ownTarget = parent.absentTargets.some((target) => matchesUniqueWhere(row, target.locator.where));
      const insertedHere =
        path !== undefined &&
        parent.insertsHidden &&
        inserted.has(extractEntityIdentity(row, pkFields)) &&
        hangsUnder(row, parent.row, path);
      if (!ownTarget && !insertedHere) {
        return [];
      }
      return [path && !path.scope.foreignKey ? withoutField(row, path.scope.backField) : row];
    }),
  );
};

const withoutField = (row: Row, fieldName: string): Row =>
  Object.fromEntries(Object.entries(row).filter(([field]) => field !== fieldName));
