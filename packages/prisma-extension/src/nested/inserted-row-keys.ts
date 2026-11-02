/**
 * Keys of the rows nested creates insert
 *
 * A nested create at a to-many path inserts rows next to the rows the relation already holds, and
 * the relation is read back whole after the write, so the rows the operation inserted are told
 * apart by the keys the extension generates for them: a row another writer inserts under the same
 * parent in between has another key. Before an operation on a row that exists runs, the key of a
 * row it inserts at a to-many path that leaves out every key field is generated with the generator
 * each field's default declares (`cuid()`, `uuid()`), as for a top-level `createMany`. Only a key
 * generated here is known to be the key the row is stored under: a key the caller gives may be
 * left out (`Prisma.skip`), stored in another form (a `uuid` column stores it in lower case) or
 * changed by a later write of the same operation. A row whose key the caller gives, or whose key
 * cannot be generated (an `autoincrement()` key, a key field the row holds as a foreign key, which
 * the relation fills from the parent row), is left as it is; its path is told apart by the rows
 * the relation held before the write instead (`nested/pre-fetch/pre-existing-rows`).
 *
 * @module nested/inserted-row-keys
 */

import { getRowKeyConstraint, type NestedOperationInfo } from '../grammar/nested-operations.js';
import type { SchemaMetadata } from '../schema/types.js';
import { withGeneratedKeyFields } from '../utils/id-generation.js';
import { isRecord } from '../utils/is-record.js';

type Row = Record<string, unknown>;

export interface CreateData {
  /** Index of the element in the operation's data, or of the row in a `createMany`'s `data`; 0 when not a list */
  readonly element: number;
  readonly data: Row;
}

/** `items` mapped by `map`; `items` itself when `map` returns every item as it is */
const mapKeeping = (items: readonly unknown[], map: (item: unknown, index: number) => unknown): readonly unknown[] => {
  const mapped = items.map(map);
  return mapped.some((item, index) => item !== items[index]) ? mapped : items;
};

const mapElements = (data: unknown, map: (element: unknown, index: number) => unknown): unknown =>
  Array.isArray(data) ? mapKeeping(data, map) : map(data, 0);

/**
 * The data of `operation` with `map` applied to the create data of each element: each element of a
 * `create`, each row of a `createMany`'s `data` (a list or one row), and the `create` of each
 * `upsert` or `connectOrCreate` element. The data itself when `map` returns every one as it is,
 * and for the other keywords, which create no row.
 */
const mapCreateData = (operation: NestedOperationInfo, map: (create: CreateData) => Row): unknown => {
  const { data } = operation;
  const mapRow = (row: unknown, element: number) => (isRecord(row) ? map({ element, data: row }) : row);
  switch (operation.operation) {
    case 'create':
      return mapElements(data, mapRow);
    case 'createMany': {
      if (!isRecord(data)) {
        return data;
      }
      const rows = mapElements(data.data, mapRow);
      return rows === data.data ? data : { ...data, data: rows };
    }
    case 'upsert':
    case 'connectOrCreate':
      return mapElements(data, (item, element) => {
        if (!isRecord(item) || !isRecord(item.create)) {
          return item;
        }
        const create = map({ element, data: item.create });
        return create === item.create ? item : { ...item, create };
      });
    default:
      return data;
  }
};

/**
 * The create data of each element of `operation`, which inserts its row when the element inserts:
 * always for a `create` or `createMany`, only when its target does not exist for an `upsert` or
 * `connectOrCreate`
 */
export const createDataOf = (operation: NestedOperationInfo): CreateData[] => {
  const creates: CreateData[] = [];
  mapCreateData(operation, (create) => {
    creates.push(create);
    return create.data;
  });
  return creates;
};

export const skipsDuplicates = (operation: NestedOperationInfo): boolean =>
  operation.operation === 'createMany' && isRecord(operation.data) && operation.data.skipDuplicates === true;

/**
 * A function that generates the key of one row `operation` inserts when the row leaves out every
 * key field and the schema can generate each, adding the row to `rowsWithGeneratedKeys`. A key
 * field the row holds as a foreign key is never generated: the relation fills it from the parent
 * row, and the create input does not take it.
 */
const keyGeneratorFor = (
  schemaMetadata: SchemaMetadata,
  operation: NestedOperationInfo,
  rowsWithGeneratedKeys: Set<object>,
) => {
  const model = operation.relatedModel;
  const keyFields = getRowKeyConstraint(schemaMetadata, model)?.fields;
  const foreignKeys = new Set(schemaMetadata.getRelationFields(model).flatMap((field) => field.foreignKeyFields));
  return ({ data: row }: CreateData): Row => {
    if (!keyFields || keyFields.some((field) => row[field] !== undefined || foreignKeys.has(field))) {
      return row;
    }
    const withKey = withGeneratedKeyFields(schemaMetadata, model, row, keyFields);
    if (withKey) {
      rowsWithGeneratedKeys.add(withKey);
    }
    return withKey ?? row;
  };
};

/**
 * `value` with each object `replacements` holds swapped for its replacement, copying only the
 * objects and arrays on the way to one, and recording in `copies` the copy each copied object
 * became. A replacement is walked too, since it shares the objects nested below it with the value
 * it replaces.
 */
const replaceObjects = (
  value: unknown,
  replacements: ReadonlyMap<unknown, unknown>,
  copies: Map<object, object>,
): unknown => {
  const replaced = replacements.has(value) ? replacements.get(value) : value;
  if (Array.isArray(replaced)) {
    const items = replaced.map((item) => replaceObjects(item, replacements, copies));
    return items.some((item, index) => item !== replaced[index]) ? items : replaced;
  }
  if (!isRecord(replaced) || Object.getPrototypeOf(replaced) !== Object.prototype) {
    return replaced;
  }
  let copy: Row | undefined;
  for (const [key, field] of Object.entries(replaced)) {
    const next = replaceObjects(field, replacements, copies);
    if (next !== field) {
      copy ??= { ...replaced };
      copy[key] = next;
    }
  }
  if (copy) {
    copies.set(replaced, copy);
  }
  return copy ?? replaced;
};

export interface InsertedRowKeys<T> {
  /** The args, with the keys filled in; the args themselves when none is */
  readonly args: T;
  readonly rowsWithGeneratedKeys: ReadonlySet<object>;
}

/**
 * The keys of the rows `operations` insert at to-many paths, filled into `args` where the schema
 * can generate them. `operations` are the nested operations detected in `args`, whose data are
 * objects of `args`.
 */
export const withInsertedRowKeys = <T extends Row>(
  schemaMetadata: SchemaMetadata,
  args: T,
  operations: readonly NestedOperationInfo[],
): InsertedRowKeys<T> => {
  const replacements = new Map<unknown, unknown>();
  const rowsWithGeneratedKeys = new Set<object>();
  for (const operation of operations) {
    if (!operation.isList) {
      continue;
    }
    const keyedData = mapCreateData(operation, keyGeneratorFor(schemaMetadata, operation, rowsWithGeneratedKeys));
    if (keyedData !== operation.data) {
      replacements.set(operation.data, keyedData);
    }
  }
  if (replacements.size === 0) {
    return { args, rowsWithGeneratedKeys };
  }
  // A keyed row that holds a keyed create of its own is copied once more on the way to it
  const copies = new Map<object, object>();
  const keyedArgs = replaceObjects(args, replacements, copies) as T;
  return {
    args: keyedArgs,
    rowsWithGeneratedKeys: new Set(Array.from(rowsWithGeneratedKeys, (row) => copies.get(row) ?? row)),
  };
};
