/**
 * The selection an audited operation runs with
 *
 * An audited row is recorded in the client's default shape together with the fields a client-level
 * `omit` hides, whatever shape the caller reads it in: its before state is read in that shape, so
 * its after state and `changes` must be too, and the entity's resolvers read the columns they name.
 * A caller `select` at a level whose rows are audited is therefore read as the default shape with
 * the relations it selects included, the fields a caller `omit` leaves out are read, and so are the
 * fields the client omits (`utils/client-omit.ts`). Enumerating the columns instead would read a
 * field the client hides even when the audit could not learn that it does, which the before state
 * then lacks.
 *
 * Nested writes are audited from the records the operation returns, so the relations an operation
 * writes are added to its selection: into `include`, or into the caller's `select` on a client that
 * cannot `omit` a field.
 * The written relations come from `detectNestedOperations` in the discovery pass, which scans
 * every branch the operation could execute (both branches of an upsert). A to-many relation the
 * operation only updates by unique WHERE is bounded to the rows the updates name, so its siblings
 * are not read; a relation the operation may insert into is read whole, since the inserted rows
 * have no identity yet, and so is one an `updateMany` writes, since its filter describes the rows
 * as they were before the write.
 *
 * What was added is recorded, so the value handed back to the caller can be projected to the shape
 * the caller requested while audit logs are built from the full result.
 *
 * @module utils/audited-selection
 */

import {
  detectNestedOperations,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  targetWhereClauses,
} from '../grammar/nested-operations.js';
import type { SchemaMetadata } from '../schema/types.js';
import { type ClientOmittedFields, omitEntriesReading } from './client-omit.js';
import { uniqueWhereAsFilter } from './compound-where.js';

/**
 * Nested write keywords whose written rows are audited from the operation result. Deleted rows are
 * audited from their pre-fetched state, and the foreign-key changes of `connect`, `set` and
 * `disconnect` from their own reads (`nested/events/link-changes.ts`).
 */
const RESULT_AUDITED_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'connectOrCreate',
]);

/** Operations that return the records they write, the only ones that take a selection */
const RECORD_RETURNING_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'update',
  'upsert',
  'delete',
  'createManyAndReturn',
  'updateManyAndReturn',
]);

export interface SelectionReading {
  readonly schemaMetadata: SchemaMetadata;
  /** Whether the client accepts a query `omit` (Prisma 6.2 and later) */
  readonly queryOmitSupported: boolean;
  readonly clientOmittedFields: ClientOmittedFields;
}

type RelationReading = Pick<SelectionReading, 'schemaMetadata' | 'clientOmittedFields'>;

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

/**
 * Operation args that read the audited rows in the client's default shape, and what that added to
 * the caller's selection
 */
export interface AuditedSelectionInjection {
  readonly args: unknown;
  /** `undefined` when the caller's selection already read the audited rows in the default shape */
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

const buildIncludeTree = (reading: RelationReading, relations: WrittenRelations): Selection =>
  Object.fromEntries(Array.from(relations, ([field, relation]) => [field, buildRelationEntry(reading, relation)]));

/**
 * Entry for one written relation, reading the fields the client omits on its model. Nested
 * relations always use `include`, which is valid even when this entry is placed under a `select`
 * field.
 *
 * @internal
 */
const buildRelationEntry = (reading: RelationReading, relation: WrittenRelation): true | Selection => {
  const entry: Selection = {};
  if (relation.rows.kind === 'rows' && relation.rows.wheres.length > 0) {
    const fieldNames = new Set(reading.schemaMetadata.getAllFields(relation.relatedModel).map((field) => field.name));
    entry.where = { OR: relation.rows.wheres.map((where) => uniqueWhereAsFilter(where, fieldNames)) };
  }
  if (relation.children.size > 0) {
    entry.include = buildIncludeTree(reading, relation.children);
  }
  const omit = omitEntriesReading(reading.clientOmittedFields.of(relation.relatedModel));
  if (omit) {
    entry.omit = omit;
  }
  return Object.keys(entry).length === 0 ? true : entry;
};

const scalarFieldNamesOf = (schemaMetadata: SchemaMetadata, modelName: string): string[] =>
  schemaMetadata
    .getAllFields(modelName)
    .filter((field) => field.kind === 'scalar' || field.kind === 'enum')
    .map((field) => field.name);

/**
 * Select every scalar field of `modelName` missing from `select`, in place: the default shape of a
 * client that cannot `omit` a field
 *
 * @returns The fields added
 * @internal
 */
const selectMissingScalarFields = (schemaMetadata: SchemaMetadata, modelName: string, select: Selection): string[] => {
  const added = scalarFieldNamesOf(schemaMetadata, modelName).filter((field) => select[field] !== true);
  for (const field of added) {
    select[field] = true;
  }
  return added;
};

/**
 * The caller's `omit` without the fields it leaves out: the audit reads them, and records their
 * names so they are left out of the value handed back. An entry set to `false` stays.
 *
 * @internal
 */
const liftOmittedFields = (omit: unknown): { omit: Selection | undefined; lifted: string[] } => {
  if (!isRecord(omit)) {
    return { omit: undefined, lifted: [] };
  }
  const kept = Object.entries(omit).filter(([, value]) => value !== true);
  return {
    omit: kept.length > 0 ? Object.fromEntries(kept) : undefined,
    lifted: Object.keys(omit).filter((field) => omit[field] === true),
  };
};

/**
 * The args reading the rows a caller `select` reads, in the client's default shape: the relations and
 * `_count` it selects are included with their own args, the written relations merged in; each
 * scalar it selects, and each field the client omits, is kept by an `omit` entry set to `false`,
 * which reads it even when the client omits it for every query; every other scalar is left out of
 * the value handed back.
 *
 * @internal
 */
const selectionInDefaultShape = (
  reading: SelectionReading,
  modelName: string,
  argsWithoutSelect: Selection,
  selected: Selection,
  relations: WrittenRelations,
): { value: Selection; injected: InjectedSelection } => {
  const scalarFields = new Set(scalarFieldNamesOf(reading.schemaMetadata, modelName));
  const selectedScalars = [...scalarFields].filter((field) => selected[field] === true);
  const selectedRelations = Object.fromEntries(
    Object.entries(selected).filter(([field, entry]) => !scalarFields.has(field) && entry !== false),
  );
  const children = mergeWrittenRelations(reading, selectedRelations, relations);

  const value: Selection = { ...argsWithoutSelect };
  if (Object.keys(children.entries).length > 0) {
    value.include = children.entries;
  }
  const kept = new Set([...selectedScalars, ...reading.clientOmittedFields.of(modelName)]);
  const omit = omitEntriesReading(kept);
  if (omit) {
    value.omit = omit;
  }
  const unselectedScalars = [...scalarFields].filter((field) => selected[field] !== true);
  return {
    value,
    injected: { keys: new Set([...children.injected.keys, ...unselectedScalars]), nested: children.injected.nested },
  };
};

/**
 * The args the rows of `modelName` at one level are read with in the client's default shape, together
 * with the fields the client omits, and what that adds to the caller's: a caller `select` is read
 * as the default shape (on a client that cannot `omit` a field, by selecting every scalar field,
 * which is that shape there); the fields a caller `omit` leaves out are read; the written relations
 * are merged into the caller's selection.
 *
 * @internal
 */
const selectAuditedRows = (
  reading: SelectionReading,
  modelName: string,
  callerArgs: Selection,
  relations: WrittenRelations,
): { value: Selection; injected: InjectedSelection } => {
  const { select, ...argsWithoutSelect } = callerArgs;
  if (isRecord(select)) {
    if (reading.queryOmitSupported) {
      return selectionInDefaultShape(reading, modelName, argsWithoutSelect, select, relations);
    }
    const children = mergeWrittenRelations(reading, select, relations);
    const addedFields = selectMissingScalarFields(reading.schemaMetadata, modelName, children.entries);
    return {
      value: { ...callerArgs, select: children.entries },
      injected: { keys: new Set([...children.injected.keys, ...addedFields]), nested: children.injected.nested },
    };
  }

  const { omit: callerOmit, ...argsWithoutOmit } = callerArgs;
  const { omit: callerKept, lifted } = liftOmittedFields(callerOmit);
  const clientOmitted = [...reading.clientOmittedFields.of(modelName)].filter((field) => callerKept?.[field] !== false);
  const omit = { ...omitEntriesReading(new Set(clientOmitted)), ...callerKept };
  const callerInclude = isRecord(callerArgs.include) ? callerArgs.include : undefined;
  const children = mergeWrittenRelations(reading, callerInclude ?? {}, relations);
  const value: Selection = Object.keys(omit).length > 0 ? { ...argsWithoutOmit, omit } : argsWithoutOmit;
  if (callerInclude || Object.keys(children.entries).length > 0) {
    value.include = children.entries;
  }
  return {
    value,
    injected: {
      keys: new Set([...lifted, ...clientOmitted, ...children.injected.keys]),
      nested: children.injected.nested,
    },
  };
};

/**
 * Merge written relations into one level of the caller's `include`/`select` entries: a relation not
 * requested is added whole; a requested one keeps the caller's arguments and gets only what's missing.
 *
 * @internal
 */
const mergeWrittenRelations = (
  reading: SelectionReading,
  callerEntries: Selection,
  relations: WrittenRelations,
): { entries: Selection; injected: InjectedSelection } => {
  const entries: Selection = { ...callerEntries };
  const keys = new Set<string>();
  const nested = new Map<string, InjectedSelection>();

  for (const [field, relation] of relations) {
    const callerValue = entries[field];

    if (callerValue === undefined || callerValue === false) {
      entries[field] = buildRelationEntry(reading, relation);
      keys.add(field);
    } else if (callerValue === true || isRecord(callerValue)) {
      const requested = selectAuditedRows(
        reading,
        relation.relatedModel,
        callerValue === true ? {} : callerValue,
        relation.children,
      );
      if (!isEmptyInjection(requested.injected)) {
        entries[field] = requested.value;
        nested.set(field, requested.injected);
      }
    }
  }

  return { entries, injected: { keys, nested } };
};

/**
 * The selection an audited operation runs with: its rows read in the client's default shape, with
 * the fields the client omits, whatever the caller's `select` or `omit`, together with the relations
 * it writes, so the audit logs are built from the rows and nested rows it wrote in the shape their
 * before states are read in.
 *
 * @returns The args to execute (`args` itself when nothing had to be added) and what was added to the
 *   caller's selection, for {@link projectToRequestedShape}
 */
export const injectAuditedSelection = (
  reading: SelectionReading,
  modelName: string,
  action: string,
  args: unknown,
): AuditedSelectionInjection => {
  if (!isRecord(args) || !RECORD_RETURNING_ACTIONS.has(action)) {
    return { args, injected: undefined };
  }

  const { schemaMetadata } = reading;
  const writtenOperations = detectNestedOperations(schemaMetadata, modelName, args, { kind: 'discovery' }).filter(
    (operation) => RESULT_AUDITED_KEYWORDS.has(operation.operation),
  );
  const { value, injected } = selectAuditedRows(
    reading,
    modelName,
    args,
    buildWrittenRelations(schemaMetadata, modelName, writtenOperations),
  );

  return isEmptyInjection(injected) ? { args, injected: undefined } : { args: value, injected };
};

/**
 * Remove what {@link injectAuditedSelection} added from an operation result, recursively, leaving
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

const ROW_RESTRICTING_ARGS = ['where', 'take', 'skip', 'cursor', 'distinct'] as const;

/**
 * The entry of the relation `fieldName` in a selection node (operation args, or the args of a
 * relation entry); undefined when the node does not read the relation
 */
export const relationSelectionOf = (node: Selection, fieldName: string): unknown => {
  const entries = isRecord(node.select) ? node.select : isRecord(node.include) ? node.include : undefined;
  return entries?.[fieldName];
};

/** The selection node the rows of a relation entry were read with: the entry's own args, or none for `true` */
export const relationNodeOf = (entry: unknown): Selection => (isRecord(entry) ? entry : {});

/**
 * Whether a relation entry returns only some of the relation's rows, so the result may not hold
 * every row the operation wrote there
 */
export const restrictsRows = (entry: unknown): boolean =>
  isRecord(entry) && ROW_RESTRICTING_ARGS.some((key) => entry[key] !== undefined);

/**
 * The `include` that reads the relations the operation writes below the rows at `path`, as
 * {@link injectAuditedSelection} adds them; undefined when nothing below `path` is written.
 */
export const writtenRelationsInclude = (
  reading: RelationReading,
  modelName: string,
  operations: readonly NestedOperationInfo[],
  path: string,
): Selection | undefined => {
  const prefix = `${path}.`;
  const below = operations.filter(
    (operation) => RESULT_AUDITED_KEYWORDS.has(operation.operation) && operation.path.startsWith(prefix),
  );
  let relations: WrittenRelations | undefined = buildWrittenRelations(reading.schemaMetadata, modelName, below);
  for (const segment of path.split('.')) {
    relations = relations?.get(segment)?.children;
  }
  return relations && relations.size > 0 ? buildIncludeTree(reading, relations) : undefined;
};
