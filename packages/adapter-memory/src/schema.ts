/**
 * Memory schema
 *
 * The primary key of each model: the only schema knowledge the adapter needs.
 */

import type { Row } from './store.js';

export type MemorySchema<TModelName extends string = string> = {
  readonly [K in TModelName]: { readonly primaryKey: readonly string[] };
};

/** Serialized primary key of `row`: a single key as its string, a composite key as a JSON array with BigInt values as strings */
export const identityOf = <TModelName extends string>(
  schema: MemorySchema<TModelName>,
  model: TModelName,
  row: Row,
): string => {
  const values = schema[model].primaryKey.map((field) => row[field]);
  return values.length === 1
    ? String(values[0])
    : JSON.stringify(values, (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
};
