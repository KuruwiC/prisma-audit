/**
 * Nested-Write Selection Injection
 *
 * Nested writes are audited from the records the operation returns, so the relations an operation
 * writes are added to its selection: into `select` when the caller selects, else into `include`.
 * The written relations come from `detectNestedOperations` in the discovery pass, which scans
 * every branch the operation could execute (both branches of an upsert). A to-many relation the
 * operation only updates by unique WHERE is bounded to the rows the updates name, so its siblings
 * are not read; a relation the operation may insert into is read whole, since the inserted rows
 * have no identity yet, and so is one an `updateMany` writes, since its filter describes the rows
 * as they were before the write. What was added is recorded, so the value handed back to the
 * caller can be projected to the shape the caller requested while audit logs are built from the
 * full result.
 *
 * @module utils/nested-write-selection
 */

import {
  detectNestedOperations,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  targetWhereClauses,
} from '../grammar/nested-operations.js';
import type { SchemaMetadata } from '../schema/types.js';
import { uniqueWhereAsFilter } from './compound-where.js';

/**
 * Nested write keywords whose written rows are audited from the operation result. Deleted rows are
 * audited from their pre-fetched state, and `connect` and `set` write no audited row of the related
 * model.
 */
const RESULT_AUDITED_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'connectOrCreate',
]);

/**
 * The rows of a written relation to read: `rows` bounds a to-many relation to the unique WHEREs
 * of the updates at its path; `all` reads the relation whole (a to-one relation, or a path whose
 * operations may insert rows or write the rows a filter matches).
 */
type RelationRows = { readonly kind: 'rows'; readonly wheres: Selection[] } | { readonly kind: 'all' };

interface WrittenRelation {
  readonly relatedModel: string;
  readonly children: WrittenRelations;
  rows: RelationRows;
}

type WrittenRelations = Map<string, WrittenRelation>;

/**
 * What was added to one level of the caller's selection: `keys` the caller did not request at all,
 * and for each relation the caller requested, what was added inside it
 */
export interface InjectedSelection {
  readonly keys: ReadonlySet<string>;
  readonly nested: ReadonlyMap<string, InjectedSelection>;
}

/** Operation args with the written relations selected, and what that added to the caller's selection */
export interface NestedWriteSelectionInjection {
  readonly args: unknown;
  /** `undefined` when the caller's selection already covered every written relation */
  readonly injected: InjectedSelection | undefined;
}

type Selection = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEmptyInjection = (injected: InjectedSelection): boolean =>
  injected.keys.size === 0 && injected.nested.size === 0;

/**
 * The rows `operation` bounds its relation to: the unique WHEREs of a to-many `update` when every
 * element names one, else the relation whole
 */
const rowsWrittenBy = (operation: NestedOperationInfo): RelationRows => {
  if (!operation.isList || operation.operation !== 'update') {
    return { kind: 'all' };
  }
  const elements = Array.isArray(operation.data) ? operation.data : [operation.data];
  const wheres = targetWhereClauses(operation.operation, operation.data);
  return wheres.length === elements.length ? { kind: 'rows', wheres } : { kind: 'all' };
};

const narrowRelationRows = (current: RelationRows, written: RelationRows): RelationRows =>
  current.kind === 'all' || written.kind === 'all'
    ? { kind: 'all' }
    : { kind: 'rows', wheres: [...current.wheres, ...written.wheres] };

const relationAt = (
  schemaMetadata: SchemaMetadata,
  root: WrittenRelations,
  modelName: string,
  path: string,
): WrittenRelation | undefined => {
  let level = root;
  let model = modelName;
  let relation: WrittenRelation | undefined;
  for (const segment of path.split('.')) {
    relation = level.get(segment);
    if (!relation) {
      const field = schemaMetadata.getRelationFields(model).find((candidate) => candidate.name === segment);
      if (!field) {
        return undefined;
      }
      relation = { relatedModel: field.relatedModel, children: new Map(), rows: { kind: 'rows', wheres: [] } };
      level.set(segment, relation);
    }
    level = relation.children;
    model = relation.relatedModel;
  }
  return relation;
};

const buildWrittenRelations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operations: readonly NestedOperationInfo[],
): WrittenRelations => {
  const root: WrittenRelations = new Map();

  for (const operation of operations) {
    const relation = relationAt(schemaMetadata, root, modelName, operation.path);
    if (relation) {
      relation.rows = narrowRelationRows(relation.rows, rowsWrittenBy(operation));
    }
  }

  return root;
};

const buildIncludeTree = (schemaMetadata: SchemaMetadata, relations: WrittenRelations): Selection =>
  Object.fromEntries(
    Array.from(relations, ([field, relation]) => [field, buildRelationEntry(schemaMetadata, relation)]),
  );

/**
 * Entry for one written relation. Nested relations always use `include`, which is valid even when
 * this entry is placed under a `select` field.
 *
 * @internal
 */
const buildRelationEntry = (schemaMetadata: SchemaMetadata, relation: WrittenRelation): true | Selection => {
  const entry: Selection = {};
  if (relation.rows.kind === 'rows' && relation.rows.wheres.length > 0) {
    const fieldNames = new Set(schemaMetadata.getAllFields(relation.relatedModel).map((field) => field.name));
    entry.where = { OR: relation.rows.wheres.map((where) => uniqueWhereAsFilter(where, fieldNames)) };
  }
  if (relation.children.size > 0) {
    entry.include = buildIncludeTree(schemaMetadata, relation.children);
  }
  return Object.keys(entry).length === 0 ? true : entry;
};

/**
 * Select every scalar field of `modelName` missing from `select`, in place
 *
 * @returns The fields added
 * @internal
 */
const selectMissingScalarFields = (schemaMetadata: SchemaMetadata, modelName: string, select: Selection): string[] => {
  const added: string[] = [];
  for (const field of schemaMetadata.getAllFields(modelName)) {
    const isScalar = field.kind === 'scalar' || field.kind === 'enum';
    if (isScalar && (select[field.name] === undefined || select[field.name] === false)) {
      select[field.name] = true;
      added.push(field.name);
    }
  }
  return added;
};

/**
 * Add a written relation to the caller's args for that relation. A nested `select` also gets the
 * related model's scalar fields for the audit entry, since select must enumerate them explicitly.
 *
 * @internal
 */
const mergeIntoRequestedRelation = (
  schemaMetadata: SchemaMetadata,
  callerArgs: Selection,
  relation: WrittenRelation,
): { value: Selection; injected: InjectedSelection } => {
  if (isRecord(callerArgs.select)) {
    const select: Selection = { ...callerArgs.select };
    const addedFields = selectMissingScalarFields(schemaMetadata, relation.relatedModel, select);

    const children = mergeWrittenRelations(schemaMetadata, select, relation.children);
    return {
      value: { ...callerArgs, select: children.entries },
      injected: { keys: new Set([...addedFields, ...children.injected.keys]), nested: children.injected.nested },
    };
  }

  const callerInclude = isRecord(callerArgs.include) ? callerArgs.include : {};
  const children = mergeWrittenRelations(schemaMetadata, callerInclude, relation.children);
  return { value: { ...callerArgs, include: children.entries }, injected: children.injected };
};

/**
 * Merge written relations into one level of the caller's `include`/`select` entries: a relation not
 * requested is added whole; a requested one keeps the caller's arguments and gets only what's missing.
 *
 * @internal
 */
const mergeWrittenRelations = (
  schemaMetadata: SchemaMetadata,
  callerEntries: Selection,
  relations: WrittenRelations,
): { entries: Selection; injected: InjectedSelection } => {
  const entries: Selection = { ...callerEntries };
  const keys = new Set<string>();
  const nested = new Map<string, InjectedSelection>();

  for (const [field, relation] of relations) {
    const callerValue = entries[field];

    if (callerValue === undefined || callerValue === false) {
      entries[field] = buildRelationEntry(schemaMetadata, relation);
      keys.add(field);
    } else if (callerValue === true || isRecord(callerValue)) {
      const requested = mergeIntoRequestedRelation(schemaMetadata, callerValue === true ? {} : callerValue, relation);
      if (!isEmptyInjection(requested.injected)) {
        entries[field] = requested.value;
        nested.set(field, requested.injected);
      }
    }
  }

  return { entries, injected: { keys, nested } };
};

/**
 * Select the relations the operation writes, so their rows are in the result the audit logs are
 * built from
 *
 * @returns The args to execute (`args` itself when nothing had to be added) and what was added to the
 *   caller's selection, for {@link projectToRequestedShape}
 */
export const injectNestedWriteSelection = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: unknown,
): NestedWriteSelectionInjection => {
  if (!isRecord(args)) {
    return { args, injected: undefined };
  }

  const writtenOperations = detectNestedOperations(schemaMetadata, modelName, args, { kind: 'discovery' }).filter(
    (operation) => RESULT_AUDITED_KEYWORDS.has(operation.operation),
  );

  if (writtenOperations.length === 0) {
    return { args, injected: undefined };
  }

  const selectionKey = isRecord(args.select) ? 'select' : 'include';
  const callerSelection = args[selectionKey];
  const { entries, injected } = mergeWrittenRelations(
    schemaMetadata,
    isRecord(callerSelection) ? callerSelection : {},
    buildWrittenRelations(schemaMetadata, modelName, writtenOperations),
  );

  if (isEmptyInjection(injected)) {
    return { args, injected: undefined };
  }

  return { args: { ...args, [selectionKey]: entries }, injected };
};

/**
 * Remove what {@link injectNestedWriteSelection} added from an operation result, recursively, leaving
 * everything the caller requested
 *
 * @param injected - What the injection added; `undefined` returns `value` itself
 */
export const projectToRequestedShape = (value: unknown, injected: InjectedSelection | undefined): unknown => {
  if (!injected) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => projectToRequestedShape(item, injected));
  }

  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (injected.keys.has(key)) {
      continue;
    }
    const nestedInjection = injected.nested.get(key);
    projected[key] = nestedInjection ? projectToRequestedShape(fieldValue, nestedInjection) : fieldValue;
  }
  return projected;
};

/** The args of a relation entry that restrict which of its rows a query returns */
const ROW_RESTRICTING_ARGS = ['where', 'take', 'skip', 'cursor', 'distinct'] as const;

/**
 * The entry of the relation `fieldName` in a selection node (operation args, or the args of a
 * relation entry): its `select` entry when the node selects, else its `include` entry; undefined
 * when the node does not read the relation.
 */
export const relationSelectionOf = (node: Selection, fieldName: string): unknown => {
  const entries = isRecord(node.select) ? node.select : isRecord(node.include) ? node.include : undefined;
  return entries?.[fieldName];
};

/** The selection node the rows of a relation entry were read with: the entry's own args, or none for `true` */
export const relationNodeOf = (entry: unknown): Selection => (isRecord(entry) ? entry : {});

/**
 * Whether a relation entry returns only some of the relation's rows: its args carry `where`,
 * `take`, `skip`, `cursor` or `distinct`
 */
export const restrictsRows = (entry: unknown): boolean =>
  isRecord(entry) && ROW_RESTRICTING_ARGS.some((key) => entry[key] !== undefined);

/**
 * The `include` that reads the relations the operation writes below the rows at `path`, as
 * {@link injectNestedWriteSelection} adds them; undefined when nothing below `path` is written.
 */
export const writtenRelationsInclude = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operations: readonly NestedOperationInfo[],
  path: string,
): Selection | undefined => {
  const prefix = `${path}.`;
  const below = operations.filter(
    (operation) => RESULT_AUDITED_KEYWORDS.has(operation.operation) && operation.path.startsWith(prefix),
  );
  let relations: WrittenRelations | undefined = buildWrittenRelations(schemaMetadata, modelName, below);
  for (const segment of path.split('.')) {
    relations = relations?.get(segment)?.children;
  }
  return relations && relations.size > 0 ? buildIncludeTree(schemaMetadata, relations) : undefined;
};
