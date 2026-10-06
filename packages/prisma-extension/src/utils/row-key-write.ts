/**
 * The key a write gives a row
 *
 * How the data an update applies to a row writes the row's key ({@link rowKeyFieldsOf}), known
 * from the arguments before the write:
 * - `none`: no key field and no relation whose foreign key holds one is given a value (`undefined`
 *   and `Prisma.skip` give none), so the row keeps the key it had;
 * - `literal`: the key fields it writes are given literal values (a value, or `{ set: value }`), so
 *   the key each row has after the write is the key it had with those fields replaced
 *   ({@link withWrittenKey}), each value in the type Prisma reads its column back in;
 * - `not-derivable`: a key field is given an operator (`increment`, `decrement`, `multiply` ...), or
 *   a relation whose foreign key holds one is written (`connect`, `disconnect` ...): the key after
 *   the write cannot be told from the arguments.
 *
 * @module utils/row-key-write
 */

import type { PrismaNamespace } from '../internal-types.js';
import type { SchemaMetadata } from '../schema/types.js';
import { rowKeyFieldsOf } from './id-generation.js';

type Row = Record<string, unknown>;

/** What a write's data is read with from the client's Prisma namespace */
export type PrismaValues = Pick<PrismaNamespace, 'skip' | 'Decimal'>;

export type RowKeyWrite =
  | { readonly kind: 'none' }
  | { readonly kind: 'literal'; readonly values: Readonly<Row> }
  | { readonly kind: 'not-derivable' };

/** A write from which the key each row has after it follows */
export type DerivableRowKeyWrite = Exclude<RowKeyWrite, { readonly kind: 'not-derivable' }>;

export const NO_ROW_KEY_WRITE: DerivableRowKeyWrite = { kind: 'none' };

const NOT_DERIVABLE: RowKeyWrite = { kind: 'not-derivable' };

const isPlainObject = (value: unknown): value is Row => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type FieldWrite =
  | { readonly written: false }
  | { readonly written: true; readonly literal: true; readonly value: unknown }
  | { readonly written: true; readonly literal: false };

const NOT_WRITTEN: FieldWrite = { written: false };

/**
 * What a data entry gives a scalar key field: nothing, a literal value, or an operator. A value
 * that is not a plain object (a string, a number, null, a Date, bytes, a Decimal) is a literal; a
 * plain object is a field operation, a literal only when it is `set` alone.
 */
const fieldWriteOf = (value: unknown, skip: unknown): FieldWrite => {
  if (value === undefined || value === skip) {
    return NOT_WRITTEN;
  }
  if (!isPlainObject(value)) {
    return { written: true, literal: true, value };
  }
  const operations = Object.entries(value).filter(([, operand]) => operand !== undefined && operand !== skip);
  if (operations.length === 0) {
    return NOT_WRITTEN;
  }
  const [only] = operations;
  return operations.length === 1 && only?.[0] === 'set'
    ? { written: true, literal: true, value: only[1] }
    : { written: true, literal: false };
};

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const dateOf = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
};

const bigIntOf = (value: unknown): unknown =>
  (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && INTEGER.test(value))
    ? BigInt(value)
    : value;

const decimalOf = (value: unknown, Decimal: PrismaValues['Decimal']): unknown =>
  Decimal !== undefined && (typeof value === 'number' || (typeof value === 'string' && DECIMAL.test(value)))
    ? new Decimal(value)
    : value;

/**
 * `value`, a literal the data gives a key field of `type`, in the type Prisma reads the column back
 * in, so the key it derives names the row the read after the write returns: a `DateTime` given as
 * a string is the Date it names, a `BigInt` given as an integer number or string is a bigint, and a
 * `Decimal` given as a number or a numeric string is a `Prisma.Decimal`. Any other value, and a
 * value the column cannot take (Prisma rejects the write), is kept as given.
 */
const asReadBack = (value: unknown, type: string | undefined, prisma: PrismaValues): unknown => {
  switch (type) {
    case 'DateTime':
      return dateOf(value);
    case 'BigInt':
      return bigIntOf(value);
    case 'Decimal':
      return decimalOf(value, prisma.Decimal);
    default:
      return value;
  }
};

/**
 * How `data`, the data an update applies to a row of `modelName`, writes the row key. `prisma` is
 * the client's Prisma namespace: its `skip` leaves its field out of the query, and its `Decimal` is
 * the type a `Decimal` column is read back in. `none` for a model with no row key and for data that
 * is not an object.
 */
export const rowKeyWriteOf = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  data: unknown,
  prisma: PrismaValues,
): RowKeyWrite => {
  const { skip } = prisma;
  const keyFields = new Set(rowKeyFieldsOf(schemaMetadata, modelName));
  if (keyFields.size === 0 || !isPlainObject(data)) {
    return NO_ROW_KEY_WRITE;
  }
  const relationHoldsKey = new Set(
    schemaMetadata
      .getRelationFields(modelName)
      .filter((relation) => relation.foreignKeyFields.some((foreignKey) => keyFields.has(foreignKey)))
      .map((relation) => relation.name),
  );
  const values: Row = {};
  for (const [field, value] of Object.entries(data)) {
    const write = keyFields.has(field) || relationHoldsKey.has(field) ? fieldWriteOf(value, skip) : NOT_WRITTEN;
    if (!write.written) {
      continue;
    }
    if (!write.literal || relationHoldsKey.has(field)) {
      return NOT_DERIVABLE;
    }
    values[field] = asReadBack(write.value, schemaMetadata.getFieldMetadata(modelName, field)?.type, prisma);
  }
  return Object.keys(values).length === 0 ? NO_ROW_KEY_WRITE : { kind: 'literal', values };
};

/** `row` with the key the write gives it: the key fields the write gives literal values replaced */
export const withWrittenKey = (row: Row, keyWrite: DerivableRowKeyWrite): Row =>
  keyWrite.kind === 'literal' ? { ...row, ...keyWrite.values } : row;
