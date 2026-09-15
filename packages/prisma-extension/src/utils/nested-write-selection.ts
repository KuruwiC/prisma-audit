/**
 * Nested-Write Selection Injection
 *
 * Nested writes are audited from the records the operation returns, so the relations an operation
 * writes are added to its selection: into `select` when the caller selects, else into `include`.
 * The written relations come from core `detectNestedOperations` in the discovery pass, which scans
 * every branch the operation could execute (both branches of an upsert). What was added is
 * recorded, so the value handed back to the caller can be projected to the shape the caller
 * requested while audit logs are built from the full result.
 *
 * @module nested-write-selection
 */

import { detectNestedOperations, type NestedOperationKeyword, type SchemaMetadata } from '@kuruwic/prisma-audit-core';

/**
 * Nested write keywords whose written rows are audited from the operation result. Deleted rows are
 * audited from their pre-fetched state, `connect` writes no row of the related model, and
 * `updateMany` rows are not read from the result.
 */
const RESULT_AUDITED_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set([
  'create',
  'createMany',
  'update',
  'upsert',
  'connectOrCreate',
]);

interface WrittenRelation {
  readonly relatedModel: string;
  readonly children: WrittenRelations;
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

const buildWrittenRelations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  paths: readonly string[],
): WrittenRelations => {
  const root: WrittenRelations = new Map();

  for (const path of paths) {
    let level = root;
    let model = modelName;
    for (const segment of path.split('.')) {
      let relation = level.get(segment);
      if (!relation) {
        const field = schemaMetadata.getRelationFields(model).find((candidate) => candidate.name === segment);
        if (!field) {
          break;
        }
        relation = { relatedModel: field.relatedModel, children: new Map() };
        level.set(segment, relation);
      }
      level = relation.children;
      model = relation.relatedModel;
    }
  }

  return root;
};

const buildIncludeTree = (relations: WrittenRelations): Selection =>
  Object.fromEntries(Array.from(relations, ([field, relation]) => [field, buildRelationEntry(relation)]));

/**
 * Entry for one written relation. Nested relations always use `include`, valid even when this entry is
 * placed under a `select` field.
 *
 * @internal
 */
const buildRelationEntry = (relation: WrittenRelation): true | Selection =>
  relation.children.size === 0 ? true : { include: buildIncludeTree(relation.children) };

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
      entries[field] = buildRelationEntry(relation);
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
 * @param schemaMetadata - Schema metadata of the audited client
 * @param modelName - Model the operation runs on
 * @param args - Operation args
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

  const writtenPaths = detectNestedOperations(schemaMetadata, modelName, args, { kind: 'discovery' })
    .filter((operation) => RESULT_AUDITED_KEYWORDS.has(operation.operation))
    .map((operation) => operation.path);

  if (writtenPaths.length === 0) {
    return { args, injected: undefined };
  }

  const selectionKey = isRecord(args.select) ? 'select' : 'include';
  const callerSelection = args[selectionKey];
  const { entries, injected } = mergeWrittenRelations(
    schemaMetadata,
    isRecord(callerSelection) ? callerSelection : {},
    buildWrittenRelations(schemaMetadata, modelName, writtenPaths),
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
 * @param value - Result of the operation executed with the injected selection
 * @param injected - What the injection added; `undefined` returns `value` itself
 * @returns The result in the shape the caller requested
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
