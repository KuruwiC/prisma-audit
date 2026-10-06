/**
 * Unique WHERE handling: Prisma's compound-unique wrapper, and whether a row is the one a unique
 * WHERE names
 *
 * @module utils/compound-where
 */

import type { UniqueConstraint } from '../schema/types.js';
import { sameKeyValue } from './id-generation.js';
import { isRecord } from './is-record.js';

/**
 * Unwraps Prisma's compound-unique WHERE wrapper (`{ a_b: { a, b } }`) into the flat
 * scalar record needed to derive an entityId from a WHERE clause.
 *
 * `findUnique` requires a composite primary key to be addressed through a single
 * generated key on `<Model>WhereUniqueInput` — `pkConstraint.name` when the key has an
 * explicit name (`@@id([a, b], name: "custom")`), or `fields.join('_')` (Prisma's default
 * naming) otherwise. A single-field PK, or a WHERE clause that isn't wrapped this way, is
 * returned unchanged.
 */
export const unwrapCompoundWhere = (
  whereClause: Record<string, unknown>,
  pkConstraint?: UniqueConstraint,
): Record<string, unknown> => {
  if (!pkConstraint || pkConstraint.fields.length <= 1) return whereClause;

  const compoundKey = pkConstraint.name ?? pkConstraint.fields.join('_');
  return (whereClause[compoundKey] as Record<string, unknown> | undefined) ?? whereClause;
};

/** A key value that is neither a string, a number nor a boolean: a BigInt, a Date, Bytes, a Decimal */
const isStructuredKeyValue = (value: unknown): boolean =>
  typeof value === 'bigint' ||
  value instanceof Uint8Array ||
  (typeof value === 'object' && value !== null && 'toJSON' in value);

/** A value a unique WHERE compares a field to; a filter object (`{ contains }`) is not one */
const isComparableValue = (value: unknown): boolean =>
  value === null || typeof value !== 'object' || isStructuredKeyValue(value);

const valuesEqual = (rowValue: unknown, whereValue: unknown): boolean =>
  isStructuredKeyValue(rowValue) || isStructuredKeyValue(whereValue)
    ? sameKeyValue(rowValue, whereValue)
    : rowValue === whereValue;

/**
 * Whether `row` is the row `whereClause`, a `<Model>WhereUniqueInput`, names: every field the WHERE
 * compares to a value holds that value in the row. A key the row does not carry wraps a
 * compound unique key (`{ a_b: { a, b } }`) and is matched through its fields; a filter object on
 * a field the row carries (`{ title: { contains } }`) cannot be evaluated and does not exclude
 * the row, since the unique key fields decide.
 */
export const matchesUniqueWhere = (row: Record<string, unknown>, whereClause: Record<string, unknown>): boolean =>
  Object.entries(whereClause).every(([field, expected]) => {
    if (field in row) {
      return isComparableValue(expected) ? valuesEqual(row[field], expected) : true;
    }
    return isRecord(expected) ? matchesUniqueWhere(row, expected) : true;
  });

/**
 * Whether `whereClause` names the row whose primary key is `key`: it compares every key field to
 * the key's value, directly or inside a compound-unique wrapper (`{ a_b: { a, b } }`).
 */
export const namesKey = (key: Record<string, unknown>, whereClause: Record<string, unknown>): boolean => {
  const wrapped = Object.values(whereClause).filter(isRecord);
  return Object.entries(key).every(([field, value]) => {
    const named = field in whereClause ? whereClause[field] : wrapped.find((inner) => field in inner)?.[field];
    return named !== undefined && isComparableValue(named) && valuesEqual(value, named);
  });
};

const sameWhereValue = (left: unknown, right: unknown): boolean => {
  if (isRecord(left) && isRecord(right)) {
    return sameUniqueWhere(left, right);
  }
  if (isRecord(left) || isRecord(right) || Array.isArray(left) || Array.isArray(right)) {
    return false;
  }
  return valuesEqual(left, right);
};

/**
 * Whether two unique WHEREs are the same WHERE: the same fields, each compared to the same value
 * (a compound-unique wrapper or a filter object compared field by field). Two WHEREs that name
 * the same row by different unique fields are not the same WHERE.
 */
export const sameUniqueWhere = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => key in right && sameWhereValue(left[key], right[key]))
  );
};

/**
 * A unique WHERE as a filter (`<Model>WhereInput`), for a query that names several rows at once:
 * the compound-unique wrapper (`{ a_b: { a, b } }`) is a WHERE-unique shape only, so its fields
 * are lifted out; a key that is neither one of `fieldNames` nor such a wrapper is dropped.
 */
export const uniqueWhereAsFilter = (
  whereClause: Record<string, unknown>,
  fieldNames: ReadonlySet<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(whereClause).flatMap(([key, value]) => {
      if (fieldNames.has(key)) {
        return [[key, value]];
      }
      return isRecord(value) ? Object.entries(value) : [];
    }),
  );
