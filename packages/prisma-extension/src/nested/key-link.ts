/**
 * Row-key fields that hold the foreign key to the parent row
 *
 * A related model can hold, in its row key, the foreign key of the relation from its parent
 * (`@@unique([deviceCode, slot])`, `deviceCode` referencing `Device.code`). A row that relation
 * holds under a parent row carries the parent's referenced columns there, and after the write the
 * parent's referenced columns as the parent has them after the write: a nested `connect` sets
 * them, and a write of the parent's referenced columns reaches them by `ON UPDATE CASCADE`. A key
 * read ahead of the write, or named by the operation, names the row after the write only with
 * those fields taken from the parent row ({@link relinked}).
 *
 * @module nested/key-link
 */

import type { NestedOperationInfo } from '../grammar/nested-operations.js';
import type { SchemaMetadata, UniqueConstraint } from '../schema/types.js';
import { unwrapCompoundWhere } from '../utils/compound-where.js';
import { rowKeyFieldsOf } from '../utils/id-generation.js';
import { relationLinkOf } from './pre-fetch/relation-link.js';

type Row = Record<string, unknown>;

export interface KeyLink {
  readonly parentModel: string;
  /** The foreign-key fields of the row key */
  readonly fields: readonly string[];
  /** The fields of the parent model each of `fields` references, in the same order */
  readonly references: readonly string[];
}

/**
 * The key link of the relation `operation` writes, below the top-level model `modelName`;
 * undefined when the related model does not hold the foreign key or its row key holds none of it
 */
export const keyLinkOf = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operation: Pick<NestedOperationInfo, 'path' | 'fieldName' | 'relatedModel'>,
): KeyLink | undefined => {
  const link = relationLinkOf(schemaMetadata, modelName, operation);
  if (link?.side !== 'related') {
    return undefined;
  }
  const keyFields = new Set(rowKeyFieldsOf(schemaMetadata, operation.relatedModel));
  const pairs = link.fields.flatMap((field, index) => {
    const reference = link.references[index];
    return keyFields.has(field) && reference !== undefined ? [{ field, reference }] : [];
  });
  return pairs.length === 0
    ? undefined
    : {
        parentModel: link.parentModel,
        fields: pairs.map(({ field }) => field),
        references: pairs.map(({ reference }) => reference),
      };
};

/**
 * The values a row the relation holds under `parentRow` has in the key link's fields: the
 * parent's referenced columns. Undefined when `parentRow` lacks one of them.
 */
export const keyLinkValuesOf = (link: KeyLink, parentRow: Row): Row | undefined => {
  const values = Object.fromEntries(
    link.fields.map((field, index) => [field, parentRow[link.references[index] ?? '']]),
  );
  return Object.values(values).some((value) => value === undefined || value === null) ? undefined : values;
};

/** `key` without the key link's fields */
export const withoutKeyLink = (key: Row, link: KeyLink): Row =>
  Object.fromEntries(Object.entries(key).filter(([field]) => !link.fields.includes(field)));

/**
 * `where`, a row key or a unique WHERE, naming its row by `values` in the key link's fields: the
 * compound-key wrapper lifted, and each of those fields it names given the value `values` holds.
 * `where` as it is when `values` is undefined or it names none of them.
 */
export const relinked = (where: Row, values: Row | undefined, keyConstraint: UniqueConstraint | undefined): Row => {
  if (!values) {
    return where;
  }
  const flat = unwrapCompoundWhere(where, keyConstraint);
  const named = Object.keys(values).filter((field) => field in flat);
  return named.length === 0 ? where : { ...flat, ...Object.fromEntries(named.map((field) => [field, values[field]])) };
};
