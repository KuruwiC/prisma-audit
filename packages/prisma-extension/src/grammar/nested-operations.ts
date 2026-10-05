/**
 * Prisma Nested-Write Grammar
 *
 * @module grammar/nested-operations
 *
 * @remarks
 * Detects the nested write operations (`create`, `connectOrCreate`, `upsert`, ...) inside
 * Prisma operation args and reads the rows a relation holds in an operation result.
 * Supports deep nesting (e.g., `postTags.create.tag.connectOrCreate`).
 */

import type { SchemaMetadata, UniqueConstraint } from '../schema/types.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../utils/identity-key.js';
import { isRecord } from '../utils/is-record.js';
import type { NestedPreFetchResult } from './nested-state.js';

export const NESTED_OPERATION_KEYWORDS = [
  'create',
  'createMany',
  'connect',
  'set',
  'disconnect',
  'connectOrCreate',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
] as const;

export type NestedOperationKeyword = (typeof NESTED_OPERATION_KEYWORDS)[number];

/** The nested keywords that name their rows by a filter rather than by a unique WHERE */
export type NestedBatchKeyword = 'updateMany' | 'deleteMany';

export const isNestedBatchKeyword = (keyword: NestedOperationKeyword): keyword is NestedBatchKeyword =>
  keyword === 'updateMany' || keyword === 'deleteMany';

/**
 * Whether `keyword` attaches existing rows, named by unique WHERE, to the parent row without
 * writing any other column of them. Their foreign-key change, when the related row holds the
 * foreign key, is audited from reads of their own (see `nested/pre-fetch/link-rows.ts`).
 */
export const linksNamedRows = (keyword: NestedOperationKeyword): boolean => keyword === 'connect' || keyword === 'set';

/** Information about a detected nested operation */
export interface NestedOperationInfo {
  /** Relation field name (e.g., 'posts') */
  fieldName: string;
  /** Related model name (e.g., 'Post') */
  relatedModel: string;
  /** Operation type (e.g., 'create', 'createMany') */
  operation: NestedOperationKeyword;
  /** Whether this is a list/array relation */
  isList: boolean;
  /** Nested operation data */
  data: unknown;
  /** Full path from root (e.g., 'postTags', 'postTags.tag') */
  path: string;
  /** Absent for an operation detected directly in the top-level args */
  parent?: NestedOperationParent;
  /**
   * The keywords the same relation field's data lists before this one, in that order, with their
   * data. Prisma runs the keywords of one relation field in the order its data lists them, so
   * these are the writes to the relation that run before this one.
   */
  writesBefore: readonly NestedWriteBefore[];
}

/** A keyword of a relation field's data and its data, listed before another keyword of that field */
export interface NestedWriteBefore {
  readonly operation: NestedOperationKeyword;
  readonly data: unknown;
}

const isNestedOperationKeyword = (key: string): key is NestedOperationKeyword =>
  (NESTED_OPERATION_KEYWORDS as readonly string[]).includes(key);

/** The keywords `fieldValue` lists before `keyword`, with their data */
const writesListedBefore = (
  fieldValue: Record<string, unknown>,
  keyword: NestedOperationKeyword,
): NestedWriteBefore[] => {
  const keys = Object.keys(fieldValue);
  return keys
    .slice(0, keys.indexOf(keyword))
    .filter(isNestedOperationKeyword)
    .map((operation) => ({ operation, data: fieldValue[operation] }));
};

/** The element of a nested operation's data that another nested operation was detected in */
export interface NestedOperationParent {
  readonly operation: NestedOperationInfo;
  /** Index of the element in the operation's data; 0 when the data is not a list */
  readonly element: number;
}

/** What the pre-fetch learned of the rows at one nested path */
export interface NestedPathPreFetch {
  readonly results: NestedPreFetchResult[];
  /**
   * A read of the path's rows that names them by no unique WHERE (the related rows of a to-one
   * relation under their parent rows) failed or could not run under every parent row, so a row of
   * the path without a result of its own reads as unavailable rather than absent
   */
  unread: boolean;
}

/** What the pre-fetch learned of the nested rows of an operation, keyed by operation path */
export type NestedPreFetchResults = Map<string, NestedPathPreFetch>;

/**
 * The primary key of every row each nested batch keyword's filter matched under its parent rows
 * before the operation, keyed by operation path, then by keyword, then by entity identity
 */
export type NestedBatchTargets = Map<string, Map<NestedBatchKeyword, Map<EntityIdentityKey, Record<string, unknown>>>>;

/** A branch of an upsert: `create` runs when the target row does not exist, `update` when it does */
export type UpsertBranch = 'create' | 'update';

/**
 * Which upsert and connectOrCreate branches {@link detectNestedOperations} scans.
 *
 * - `discovery`: the operation has not run, so which branch of a nested upsert executes, or
 *   whether a connectOrCreate creates its row, is unknown. Every branch of every nested upsert and
 *   the `create` data of every connectOrCreate are scanned, so every nested record the operation
 *   could write is found (e.g. to pre-fetch its before-state). `topLevelUpsertBranch` is the
 *   branch the top-level upsert will execute when its row was read ahead of the operation, and
 *   only that branch's top-level args are scanned; absent, both are.
 * - `executed`: the operation ran, and only the writes of the branches that executed are reported.
 *   `topLevelUpsertBranch` is the branch the top-level upsert executed; it is absent when the
 *   operation is not an upsert, and the top-level `create` / `update` args are then not scanned.
 *   `branchAt(operation, where)` is the branch an element of the nested upsert or connectOrCreate
 *   `operation` executed: `update` (a connect, for a connectOrCreate) when its target existed
 *   before the operation, `create` when it did not, undefined when that could not be read, and
 *   then nothing of the element is scanned. `where` is the element's unique WHERE, absent for a
 *   to-one upsert, which targets the related row of its parent row. A connectOrCreate's `create`
 *   data is scanned only on its `create` branch.
 */
export type NestedDetectionPass =
  | { readonly kind: 'discovery'; readonly topLevelUpsertBranch?: UpsertBranch }
  | {
      readonly kind: 'executed';
      readonly topLevelUpsertBranch?: UpsertBranch;
      readonly branchAt: (
        operation: NestedOperationInfo,
        where: Record<string, unknown> | undefined,
      ) => UpsertBranch | undefined;
    };

type RelationField = { name: string; relatedModel: string; isList: boolean };

/** An element of a nested operation's data that the scan descends into, by its index in that data */
interface ScannedElement {
  readonly element: number;
  readonly data: Record<string, unknown>;
}

const elementsOf = (data: unknown): unknown[] => (Array.isArray(data) ? data : [data]);

const elementBranches = (
  pass: NestedDetectionPass,
  operation: NestedOperationInfo,
  element: Record<string, unknown>,
): readonly UpsertBranch[] => {
  if (pass.kind === 'discovery') {
    return ['update', 'create'];
  }
  const where = isRecord(element.where) ? element.where : undefined;
  const branch = pass.branchAt(operation, where);
  return branch ? [branch] : [];
};

/**
 * @internal The data of the upsert branches the pass scans, element by element: a to-many upsert is
 * one `{ where, create, update }` or a list of them, each taking its own branch.
 */
const upsertBranchData = (pass: NestedDetectionPass, operation: NestedOperationInfo): ScannedElement[] =>
  elementsOf(operation.data).flatMap((element, index) =>
    isRecord(element)
      ? elementBranches(pass, operation, element)
          .map((branch) => element[branch])
          .filter(isRecord)
          .map((data) => ({ element: index, data }))
      : [],
  );

/**
 * @internal The `create` data of the connectOrCreate elements whose `create` branch the pass
 * scans: a to-many connectOrCreate is one `{ where, create }` or a list of them, each creating
 * its row or connecting an existing one on its own.
 */
const connectOrCreateCreateData = (pass: NestedDetectionPass, operation: NestedOperationInfo): ScannedElement[] =>
  elementsOf(operation.data).flatMap((element, index) =>
    isRecord(element) && isRecord(element.create) && elementBranches(pass, operation, element).includes('create')
      ? [{ element: index, data: element.create }]
      : [],
  );

/** @internal Whether a to-one nested `update` value is the `{ where?, data }` form rather than the data itself */
const isToOneUpdateWithWhere = (update: Record<string, unknown>): boolean =>
  typeof update.data === 'object' &&
  update.data !== null &&
  Object.keys(update).every((key) => key === 'where' || key === 'data');

/**
 * @internal The data objects a nested `update` writes: a to-many update is one `{ where, data }` or a
 * list of them; a to-one update is either `{ where?, data }` or the data object itself.
 */
const updateData = (operation: NestedOperationInfo): ScannedElement[] =>
  elementsOf(operation.data).flatMap((update, index) => {
    if (!isRecord(update)) {
      return [];
    }
    if (operation.isList || isToOneUpdateWithWhere(update)) {
      return isRecord(update.data) ? [{ element: index, data: update.data }] : [];
    }
    return [{ element: index, data: update }];
  });

const scannedElementsOf = (operation: NestedOperationInfo, pass: NestedDetectionPass): ScannedElement[] => {
  switch (operation.operation) {
    case 'create':
    case 'createMany':
      return elementsOf(operation.data).flatMap((data, index) => (isRecord(data) ? [{ element: index, data }] : []));
    case 'update':
      return updateData(operation);
    case 'upsert':
      return upsertBranchData(pass, operation);
    case 'connectOrCreate':
      return connectOrCreateCreateData(pass, operation);
    default:
      return [];
  }
};

/**
 * @internal A nested operation and, after it, every write detected inside its data, each nested
 * under the element it was found in
 */
const detectOperationAndNested = (
  schemaMetadata: SchemaMetadata,
  relationField: RelationField,
  keyword: NestedOperationKeyword,
  fieldValue: Record<string, unknown>,
  parent: NestedOperationParent | undefined,
  pass: NestedDetectionPass,
): NestedOperationInfo[] => {
  const operation: NestedOperationInfo = {
    fieldName: relationField.name,
    relatedModel: relationField.relatedModel,
    operation: keyword,
    isList: relationField.isList,
    data: fieldValue[keyword],
    path: parent ? `${parent.operation.path}.${relationField.name}` : relationField.name,
    parent,
    writesBefore: writesListedBefore(fieldValue, keyword),
  };

  const nested = scannedElementsOf(operation, pass).flatMap(({ element, data }) =>
    detectOperationsIn(schemaMetadata, relationField.relatedModel, data, { operation, element }, pass),
  );
  return [operation, ...nested];
};

const detectOperationsIn = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  data: Record<string, unknown>,
  parent: NestedOperationParent | undefined,
  pass: NestedDetectionPass,
  isNew: (relationField: RelationField, keyword: NestedOperationKeyword, nestedData: unknown) => boolean = () => true,
): NestedOperationInfo[] =>
  schemaMetadata.getRelationFields(modelName).flatMap((relationField) => {
    const fieldValue = data[relationField.name];
    if (!isRecord(fieldValue)) {
      return [];
    }
    return NESTED_OPERATION_KEYWORDS.flatMap((keyword) => {
      const nestedData = fieldValue[keyword];
      if (nestedData === undefined || !isNew(relationField, keyword, nestedData)) {
        return [];
      }
      return detectOperationAndNested(schemaMetadata, relationField, keyword, fieldValue, parent, pass);
    });
  });

/** @internal Extract data sources from args: `data`, and the top-level upsert branches the pass selects */
const extractDataSources = (args: Record<string, unknown>, pass: NestedDetectionPass): Record<string, unknown>[] => {
  const branches = pass.topLevelUpsertBranch
    ? [pass.topLevelUpsertBranch]
    : pass.kind === 'discovery'
      ? ['create', 'update']
      : [];
  return [args.data, ...branches.map((branch) => args[branch])].filter(isRecord);
};

/**
 * Detect nested operations in operation args
 *
 * Main entry point for detecting all nested write operations (every keyword in `NESTED_OPERATION_KEYWORDS`)
 * at any depth level. Supports deeply nested operations like `postTags.create.tag.connectOrCreate`.
 * Each operation is detected once per element of the data it is nested in, and records that
 * element as its `parent`. Both branches of a top-level upsert are scanned whole, the same keyword
 * on the same relation included, since either branch may hold writes the other does not; one
 * value both branches share is detected once.
 *
 * **Upsert branches:** `pass` decides which branches of the top-level upsert and of nested upserts
 * are scanned — all of them in the discovery pass, the executed ones in the executed pass
 * (see {@link NestedDetectionPass}).
 *
 * **Path Format:**
 * - Top-level: `"posts"`
 * - Nested: `"postTags.tag"`
 * - Deep: `"author.profile.avatar"`
 *
 * @example
 * ```typescript
 * const args = {
 *   where: { id: 'user-1' },
 *   create: { email: 'new@example.com', profile: { create: { bio: 'New' } } },
 *   update: { profile: { upsert: { create: { bio: 'New' }, update: { bio: 'Updated', avatar: { update: {...} } } } } },
 * };
 *
 * // Discovery pass, before the operation runs
 * detectNestedOperations(schemaMetadata, 'User', args, { kind: 'discovery' });
 * // Result: profile create, profile upsert, avatar update
 *
 * // Executed pass: the user existed and so did its profile
 * detectNestedOperations(schemaMetadata, 'User', args, {
 *   kind: 'executed',
 *   topLevelUpsertBranch: 'update',
 *   branchAt: (operation) => (operation.path === 'profile' ? 'update' : 'create'),
 * });
 * // Result: profile upsert, avatar update
 * ```
 */
export const detectNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Record<string, unknown>,
  pass: NestedDetectionPass,
): NestedOperationInfo[] => {
  const detected = new Map<string, Set<unknown>>();
  const isNew = (relationField: RelationField, keyword: NestedOperationKeyword, nestedData: unknown): boolean => {
    const key = `${relationField.name}:${keyword}`;
    const values = detected.get(key) ?? new Set<unknown>();
    detected.set(key, values);
    if (values.has(nestedData)) {
      return false;
    }
    values.add(nestedData);
    return true;
  };

  return extractDataSources(args, pass).flatMap((data) =>
    detectOperationsIn(schemaMetadata, modelName, data, undefined, pass, isNew),
  );
};

/** A row a nested operation names by unique WHERE, with the element of its data that names it */
export interface NamedTarget {
  /** Index of the element in the operation's data; 0 when the data is not a list */
  readonly element: number;
  readonly where: Record<string, unknown>;
}

/**
 * The unique WHERE of every row a nested operation names: the `where` of each `update`, `upsert`
 * and `connectOrCreate` element, the element itself for `delete`, `connect`, `set` and
 * `disconnect`; one per element when `data` is a list. `updateMany` / `deleteMany` name rows by a
 * filter, not a unique WHERE, and yield none, as do the keywords that only insert and a to-one
 * `disconnect: true`.
 */
export const namedTargets = (operation: NestedOperationKeyword, data: unknown): NamedTarget[] => {
  const items = elementsOf(data);

  if (operation === 'update' || operation === 'upsert' || operation === 'connectOrCreate') {
    return items.flatMap((item, element) =>
      isRecord(item) && isRecord(item.where) ? [{ element, where: item.where }] : [],
    );
  }

  if (operation === 'delete' || operation === 'disconnect' || linksNamedRows(operation)) {
    return items.flatMap((item, element) => (isRecord(item) ? [{ element, where: item }] : []));
  }

  return [];
};

export const targetWhereClauses = (operation: NestedOperationKeyword, data: unknown): Record<string, unknown>[] =>
  namedTargets(operation, data).map((target) => target.where);

/**
 * The filter of every element of a nested batch keyword: the `where` of each `updateMany` element,
 * the element itself for `deleteMany`; one per element when `data` is a list. A filter is a
 * `<Model>ScalarWhereInput` that any number of rows may match, so, unlike a unique WHERE, it
 * names its rows only through a query.
 */
export const batchFilterClauses = (operation: NestedBatchKeyword, data: unknown): Record<string, unknown>[] => {
  const items = Array.isArray(data) ? data : [data];

  if (operation === 'updateMany') {
    return items.map((item) => (isRecord(item) ? item.where : undefined)).filter(isRecord);
  }

  return items.filter(isRecord);
};

export const relationRowsOf = (
  row: Record<string, unknown>,
  relationField: { readonly name: string; readonly isList: boolean },
): Record<string, unknown>[] => {
  const value = row[relationField.name];
  return (relationField.isList ? (Array.isArray(value) ? value : []) : [value]).filter(isRecord);
};

/**
 * A model's primary key: its `@@id` constraint, else its `@id` field.
 *
 * The `@@id` constraint keeps its declared `name` (`@@id([a, b], name: "custom")`), which Prisma
 * uses, or `fields.join('_')` when absent, as the compound-unique WHERE key.
 *
 * @returns The primary key, or `undefined` when the model declares none
 */
export const getPrimaryKeyConstraint = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
): UniqueConstraint | undefined => {
  const primaryKey = schemaMetadata.getUniqueConstraints(modelName).find((c) => c.type === 'primaryKey');
  if (primaryKey && primaryKey.fields.length > 0) return primaryKey;

  const idField = schemaMetadata.getAllFields(modelName).find((f) => f.isId);
  if (idField) return { type: 'primaryKey', fields: [idField.name] };

  return undefined;
};

/**
 * Rebuild the primary-key fields of a record from its serialized entity identity: the value
 * itself for a single-field key, a JSON array in `pkFields` order for a composite key.
 *
 * @returns The primary-key fields, or `null` when the full key cannot be recovered: the identity
 *   is {@link UNRESOLVED_ENTITY_ID}, or a composite identity is not a JSON array of
 *   `pkFields.length` elements. A partial key is never returned, since it would read as a complete
 *   identity.
 */
export const deserializeEntityId = (
  entityId: EntityIdentityKey,
  pkFields: readonly string[],
): Record<string, unknown> | null => {
  if (entityId === UNRESOLVED_ENTITY_ID) return null;

  if (pkFields.length === 1) {
    return { [pkFields[0] as string]: entityId };
  }
  try {
    const parsed: unknown = JSON.parse(entityId);
    if (!Array.isArray(parsed) || parsed.length !== pkFields.length) return null;
    const pk: Record<string, unknown> = {};
    for (let i = 0; i < pkFields.length; i++) {
      pk[pkFields[i] as string] = parsed[i];
    }
    return pk;
  } catch {
    // Composite PK but not valid JSON — cannot reconstruct
    return null;
  }
};
