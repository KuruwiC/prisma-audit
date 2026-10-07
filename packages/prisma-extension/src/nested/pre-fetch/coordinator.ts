/**
 * Pre-fetch coordinator: detects the nested operations in an operation's args, selects the ones
 * whose before state is read ahead of the write, and runs the to-one, to-many and batch fetchers
 * for them parents first, storing what each read learned under the operation's path.
 *
 * @module nested/pre-fetch/coordinator
 */

import type { FailureSink } from '@kuruwic/db-audit-core';
import {
  detectNestedOperations,
  getPrimaryKeyConstraint,
  isNestedBatchKeyword,
  type NestedBatchKeyword,
  type NestedBatchTargets,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  namedTargets,
  targetWhereClauses,
  type UpsertBranch,
} from '../../grammar/nested-operations.js';
import type { ParentRowIdentity } from '../../grammar/nested-state.js';
import {
  filterOperationsToPreFetch,
  type ShouldFetchBefore,
  sortByPathDepth,
} from '../../grammar/pre-fetch-selection.js';
import type { PrismaHandle } from '../../internal-types.js';
import type { RelationField, SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import type { AuditedOmittedFields } from '../../utils/audited-omitted-fields.js';
import { beforeStateOf, NO_BEFORE_STATE } from '../../utils/before-state.js';
import { preFetchLog } from '../../utils/debug.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import { toError } from '../../utils/to-error.js';
import { linkWriteOf } from './link-rows.js';
import {
  getPreFetchListClient,
  getPreFetchModelClient,
  type PreFetchModelClient,
  type PreFetchRecord,
} from './model-client.js';
import {
  preFetchOneToManyRelation,
  preFetchToManyBatch,
  resolveToManyRelationScope,
  type ToManyScopeInput,
} from './one-to-many-fetcher.js';
import {
  type PreFetchOneToOneResult,
  preFetchOneToOneRelation,
  resolveToOneRelationLink,
} from './one-to-one-fetcher.js';
import {
  parentKeysFromOperationWheres,
  parentPathOf,
  parentRowIdentityOf,
  targetsNamedByWhere,
  writesLinkedRow,
} from './parent-rows.js';
import {
  extractEntityIdOrUnresolved,
  markPathUnread,
  preFetchedResultUnder,
  primaryKeyNamedBy,
  storeIdentifiedRow,
  storePreFetchResult,
  storeReadResult,
  storeUnreadRows,
} from './pre-fetch-result-store.js';
import { relationLinkOf } from './relation-link.js';
import { elementNaming, readEachTarget, type TargetReadFailureHandler } from './target-reads.js';

export interface PreFetchCoordinatorDependencies {
  readonly schemaMetadata: SchemaMetadata;
  readonly shouldFetchBefore: ShouldFetchBefore;
  readonly auditedOmittedFields: AuditedOmittedFields;
  /**
   * Notified once per failed pre-fetch read of a nested operation, with `params` naming what the
   * read was for: a row an element of the operation names by unique WHERE is read on its own, so a
   * failed read of it is reported once with that element as `params`; any other read is reported
   * once per operation with the operation's data as `params`. The rows the read left unknown are
   * recorded as `unavailable` (see pre-fetch-result-store.ts), and the caller's own operation
   * continues. Mirrors the top-level equivalent, `fetchBeforeState` in pipeline/before-state.ts,
   * which reports the same failure class through the same observer.
   * Optional: when omitted, the failure is visible only via `preFetchLog`. The filter read of an
   * `updateMany` / `deleteMany` is not reported here: it identifies the rows the keyword writes,
   * so its failure rejects the pre-fetch, like the read of a top-level batch operation.
   */
  readonly onPreFetchFailure?: FailureSink['notify'];
}

export interface NestedPreFetch {
  /**
   * What the reads learned of the rows at each operation path, each result named by how its read
   * named the row; empty when nothing was pre-fetched
   */
  readonly results: NestedPreFetchResults;
  /** The primary keys of the rows each nested batch keyword's filter matched under its parent rows */
  readonly batchTargets: NestedBatchTargets;
}

/**
 * Resolves the model that declares the last segment of `path` by walking the relation fields from
 * `topLevelModel` (e.g. `'postTags.tag'` under Post resolves to PostTag).
 */
export const resolveParentModelFromPath = (
  path: string,
  topLevelModel: string,
  schemaMetadata: SchemaMetadata,
): string => {
  if (!path.includes('.')) {
    return topLevelModel;
  }

  const pathSegments = path.split('.');
  const parentPathSegments = pathSegments.slice(0, -1);

  let currentModel = topLevelModel;

  for (const segment of parentPathSegments) {
    const segmentField = findRelationField(schemaMetadata, currentModel, segment);

    if (!segmentField) {
      break;
    }

    currentModel = segmentField.relatedModel;
  }

  return currentModel;
};

/** The relation field `fieldName` of `modelName`; nested operations are always written through a relation field */
export const findRelationField = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  fieldName: string,
): RelationField | undefined => schemaMetadata.getRelationFields(modelName).find((f) => f.name === fieldName);

const categorizeRelationType = (
  field: RelationField,
): {
  readonly isOneToOne: boolean;
  readonly isOwningSide: boolean;
} => {
  const isOneToOne = !field.isList;
  const isOwningSide = field.foreignKeyFields.length > 0;

  return { isOneToOne, isOwningSide };
};

/**
 * Reports a failed pre-fetch read of a nested operation through the optional
 * `onPreFetchFailure` callback (see {@link PreFetchCoordinatorDependencies.onPreFetchFailure}).
 * A no-op when no callback is configured.
 */
const reportNestedPreFetchFailure = async (
  onPreFetchFailure: FailureSink['notify'] | undefined,
  nestedOp: NestedOperationInfo,
  params: unknown,
  error: unknown,
): Promise<void> => {
  if (!onPreFetchFailure) return;

  await onPreFetchFailure({
    phase: 'pre-fetch',
    modelName: nestedOp.relatedModel,
    operation: nestedOp.operation,
    params,
    error: toError(error),
  });
};

/**
 * Pre-fetches nested records before operation execution.
 *
 * Detects nested operations with the discovery pass, which scans every nested upsert branch, so
 * the before-state of every nested record the operation could write is captured. Of a top-level
 * upsert only `topLevelUpsertBranch` is scanned, the branch its row read decided; both when it is
 * absent. `prismaClient` must be the client of the transaction the operation runs in.
 *
 * @returns The before-states read and the rows each batch keyword's filter matched
 * @throws The error of a failed batch keyword filter read
 */
export const preFetchNestedRecordsBeforeOperation = async (
  prismaClient: PrismaHandle,
  modelName: string,
  args: Record<string, unknown>,
  dependencies: PreFetchCoordinatorDependencies,
  topLevelUpsertBranch?: UpsertBranch,
): Promise<NestedPreFetch> => {
  const { schemaMetadata, shouldFetchBefore, auditedOmittedFields, onPreFetchFailure } = dependencies;

  const preFetchResults: NestedPreFetchResults = new Map();
  const batchTargets: NestedBatchTargets = new Map();
  const preFetch: NestedPreFetch = { results: preFetchResults, batchTargets };

  const nestedOperations = detectNestedOperations(schemaMetadata, modelName, args, {
    kind: 'discovery',
    topLevelUpsertBranch,
  });
  preFetchLog('pre-fetch nested records for model=%s operations=%d', modelName, nestedOperations.length);

  const operationsToPreFetch = filterOperationsToPreFetch(nestedOperations, shouldFetchBefore);
  preFetchLog(
    'operations to pre-fetch: count=%d operations=%O',
    operationsToPreFetch.length,
    operationsToPreFetch.map((op) => ({ operation: op.operation, fieldName: op.fieldName })),
  );

  const preFetchedOperations = new Set(operationsToPreFetch);
  const rowsToIdentify = updatedRowsToIdentify(nestedOperations, preFetchedOperations, (operation) =>
    detachesUnderParent(schemaMetadata, modelName, shouldFetchBefore, operation),
  );

  if (operationsToPreFetch.length === 0 && rowsToIdentify.size === 0) {
    return preFetch;
  }

  const sortedOperations = sortByPathDepth([...operationsToPreFetch, ...rowsToIdentify.keys()]);

  preFetchLog(
    'sorted operations by depth: %O',
    sortedOperations.map((op) => ({ path: op.path, depth: op.path.split('.').length })),
  );

  const pkConstraintCache = new Map<string, UniqueConstraint | undefined>();

  const context: NestedPreFetchContext = {
    prismaClient,
    modelName,
    schemaMetadata,
    nestedOperations,
    topLevelModelClient: getPreFetchModelClient(prismaClient, modelName, auditedOmittedFields),
    topLevelWhere: args.where,
    preFetchResults,
    batchTargets,
    shouldFetchBefore,
    auditedOmittedFields,
    onPreFetchFailure,
    resolvePkConstraint: (model) => {
      if (!pkConstraintCache.has(model)) {
        pkConstraintCache.set(model, getPrimaryKeyConstraint(schemaMetadata, model));
      }
      return pkConstraintCache.get(model);
    },
    parentOperationsNotPreFetched: (path) => {
      const parentPath = parentPathOf(path);
      if (parentPath === undefined) return [];
      return nestedOperations.filter((op) => op.path === parentPath && !preFetchedOperations.has(op));
    },
  };

  for (const nestedOp of sortedOperations) {
    try {
      const childRelations = rowsToIdentify.get(nestedOp);
      await (childRelations
        ? identifyUpdatedRows(context, nestedOp, childRelations)
        : preFetchNestedOperation(context, nestedOp));
    } catch (error) {
      if (isNestedBatchKeyword(nestedOp.operation)) {
        throw error;
      }
      await recordFailedRead(
        context,
        nestedOp,
        targetsNamedByWhere(nestedOp) ? targetWhereClauses(nestedOp.operation, nestedOp.data) : undefined,
        nestedOp.data,
        error,
      );
    }
  }

  return preFetch;
};

/**
 * Nested keywords that insert rows at a to-many path whose pre-existing rows are snapshotted under
 * their parent rows
 */
const SNAPSHOTTED_INSERTS: ReadonlySet<string> = new Set(['create', 'createMany']);

/**
 * Whether `operation` is a link write that detaches the rows attached under its parent row and
 * whose rows are read (see `link-rows.ts`), so its parent row must be known before the write
 */
const detachesUnderParent = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  shouldFetchBefore: ShouldFetchBefore,
  operation: NestedOperationInfo,
): boolean => {
  const link = relationLinkOf(schemaMetadata, modelName, operation);
  return (
    link?.side === 'related' &&
    shouldFetchBefore(operation.relatedModel, 'update') &&
    linkWriteOf(operation, link)?.detaches === true
  );
};

/**
 * The `update`s whose row is not pre-fetched (`fetchBefore` turns it off) but is needed as a
 * parent row: an operation nested below it is read under its parent rows (a pre-fetched
 * operation other than a connectOrCreate, whose WHERE names its row under any parent, or a link
 * write that detaches the rows attached under it), or inserts rows at a to-many path whose
 * pre-existing rows are snapshotted under them. Each is keyed to the relation fields below it
 * that those operations go through. A to-one `update` is taken once per path, since its read
 * covers every parent row at the parent path; a to-many `update` once per operation, since its
 * read covers the rows its own elements name.
 */
const updatedRowsToIdentify = (
  nestedOperations: readonly NestedOperationInfo[],
  preFetchedOperations: ReadonlySet<NestedOperationInfo>,
  detaches: (operation: NestedOperationInfo) => boolean,
): Map<NestedOperationInfo, Set<string>> => {
  const dependents = nestedOperations.filter(
    (op) =>
      (preFetchedOperations.has(op) && op.operation !== 'connectOrCreate') ||
      (op.isList && SNAPSHOTTED_INSERTS.has(op.operation)) ||
      detaches(op),
  );
  const identified = new Map<NestedOperationInfo, Set<string>>();
  const identifiedPaths = new Set<string>();
  for (const op of nestedOperations) {
    if (op.operation !== 'update' || preFetchedOperations.has(op) || identifiedPaths.has(op.path)) {
      continue;
    }
    const prefix = `${op.path}.`;
    const childRelations = new Set(
      dependents
        .filter((dependent) => dependent.path.startsWith(prefix))
        .map((dependent) => dependent.path.slice(prefix.length).split('.')[0] ?? ''),
    );
    if (childRelations.size > 0) {
      identified.set(op, childRelations);
      if (!op.isList) {
        identifiedPaths.add(op.path);
      }
    }
  }
  return identified;
};

interface NestedPreFetchContext {
  prismaClient: PrismaHandle;
  modelName: string;
  schemaMetadata: SchemaMetadata;
  /** Every nested operation the discovery pass detected */
  nestedOperations: readonly NestedOperationInfo[];
  topLevelModelClient: PreFetchModelClient | undefined;
  topLevelWhere: unknown;
  preFetchResults: NestedPreFetchResults;
  batchTargets: NestedBatchTargets;
  shouldFetchBefore: ShouldFetchBefore;
  auditedOmittedFields: AuditedOmittedFields;
  onPreFetchFailure: FailureSink['notify'] | undefined;
  resolvePkConstraint: (model: string) => UniqueConstraint | undefined;
  /** Operations at the parent path of `path` that were not pre-fetched; none for a direct child */
  parentOperationsNotPreFetched: (path: string) => NestedOperationInfo[];
}

interface NestedRelation {
  readonly nestedOp: NestedOperationInfo;
  readonly field: RelationField;
  readonly parentModel: string;
  readonly pkConstraint: UniqueConstraint;
}

/**
 * Records the rows a failed pre-fetch read of `nestedOp` left unknown (see `storeUnreadRows`):
 * those `wheres` names, or, when undefined, the rows of the path the read did not name on its own.
 * Then reports the failure with `params`, the part of the operation's data the read was for.
 */
const recordFailedRead = async (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
  wheres: readonly PreFetchRecord[] | undefined,
  params: unknown,
  error: unknown,
): Promise<void> => {
  storeUnreadRows(context.preFetchResults, nestedOp.path, wheres, context.resolvePkConstraint(nestedOp.relatedModel));
  preFetchLog('pre-fetch failed: path=%s error=%o', nestedOp.path, error);
  await reportNestedPreFetchFailure(context.onPreFetchFailure, nestedOp, params, error);
};

/** Records a failed read of the row one element of `nestedOp` names, leaving the other rows of the path as read */
const targetReadFailureHandler =
  (context: NestedPreFetchContext, nestedOp: NestedOperationInfo): TargetReadFailureHandler =>
  (target, error) =>
    recordFailedRead(context, nestedOp, [target.where], elementNaming(nestedOp.data, target), error);

const resolveNestedRelation = (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
): NestedRelation | undefined => {
  const { modelName, schemaMetadata, resolvePkConstraint } = context;

  const parentModel = resolveParentModelFromPath(nestedOp.path, modelName, schemaMetadata);
  const field = findRelationField(schemaMetadata, parentModel, nestedOp.fieldName);
  if (!field) {
    preFetchLog('field not found in model: model=%s field=%s', parentModel, nestedOp.fieldName);
    return undefined;
  }

  const pkConstraint = resolvePkConstraint(nestedOp.relatedModel);
  if (!pkConstraint) {
    preFetchLog('model has no primary key, skipping pre-fetch: model=%s path=%s', nestedOp.relatedModel, nestedOp.path);
    return undefined;
  }

  return { nestedOp, field, parentModel, pkConstraint };
};

const preFetchNestedOperation = async (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
): Promise<void> => {
  const relation = resolveNestedRelation(context, nestedOp);
  if (!relation) {
    return;
  }

  if (isNestedBatchKeyword(nestedOp.operation)) {
    await handleToManyBatch(context, relation, nestedOp.operation);
    return;
  }

  const relatedModelClient = getPreFetchModelClient(
    context.prismaClient,
    nestedOp.relatedModel,
    context.auditedOmittedFields,
  );
  if (!relatedModelClient) {
    preFetchLog('model client not found: model=%s', nestedOp.relatedModel);
    return;
  }

  const { isOneToOne, isOwningSide } = categorizeRelationType(relation.field);
  preFetchLog(
    'processing field: field=%s operation=%s isOneToOne=%s isOwningSide=%s',
    nestedOp.fieldName,
    nestedOp.operation,
    isOneToOne,
    isOwningSide,
  );

  if (nestedOp.operation === 'connectOrCreate') {
    await handleConnectOrCreate(context, nestedOp, relatedModelClient, relation.pkConstraint);
    return;
  }

  if (isOneToOne) {
    await handleOneToOneRelation(context, relation, relatedModelClient);
  } else {
    await handleOneToManyRelation(context, relation, relatedModelClient);
  }
};

/**
 * Pre-fetches the row each `connectOrCreate` WHERE names, on either relation cardinality.
 *
 * Not scoped to the parent rows: `connect` re-parents an existing row, so the row the WHERE names
 * is the target whichever parent it belongs to. The WHERE is a `<Model>WhereUniqueInput`, which
 * `findUnique` accepts natively, including a composite-key compound-unique shape.
 */
const handleConnectOrCreate = async (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
  relatedModelClient: PreFetchModelClient,
  pkConstraint: UniqueConstraint,
): Promise<void> => {
  await readEachTarget(
    namedTargets(nestedOp.operation, nestedOp.data),
    async (where) => {
      const beforeRecord = await relatedModelClient.findUnique({ where });
      storeReadResult(context.preFetchResults, nestedOp.path, where, beforeRecord, pkConstraint);
      preFetchLog('connectOrCreate stored: path=%s found=%s', nestedOp.path, beforeRecord !== null);
    },
    targetReadFailureHandler(context, nestedOp),
  );
};

/**
 * Stores what a to-one read found under each parent row: the related row as its before state,
 * or, for a read of its key columns only, its key without a before state, which never replaces
 * what another read found under that parent row.
 */
const storeToOneResults = (
  preFetchResults: NestedPreFetchResults,
  path: string,
  results: readonly PreFetchOneToOneResult[],
  pkFields: readonly string[],
  keyColumnsOnly: boolean,
): void => {
  for (const { parent, beforeRecord } of results) {
    const name = { by: 'parentRow', parent } as const;
    const identity = extractEntityIdOrUnresolved(beforeRecord, pkFields);
    if (!keyColumnsOnly) {
      storePreFetchResult(preFetchResults, path, { before: beforeStateOf(beforeRecord), identity, name });
    } else if (!preFetchedResultUnder(preFetchResults, path, parent)) {
      storePreFetchResult(preFetchResults, path, {
        before: NO_BEFORE_STATE,
        identity,
        name,
        ...(beforeRecord ? { key: beforeRecord } : {}),
      });
    }
    preFetchLog('1:1 added to map: path=%s found=%s', path, beforeRecord !== null);
  }
};

const handleOneToOneRelation = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  relatedModelClient: PreFetchModelClient,
  keyColumns?: Record<string, true>,
): Promise<void> => {
  const { topLevelWhere, topLevelModelClient, preFetchResults, resolvePkConstraint } = context;
  const { nestedOp, field, parentModel, pkConstraint } = relation;
  const parentPkConstraint = resolvePkConstraint(parentModel);
  const { results, parentsKnown } = await preFetchOneToOneRelation({
    path: nestedOp.path,
    link: resolveToOneRelationLink(context.schemaMetadata, field),
    parentPkFields: parentPkConstraint?.fields ?? [],
    parentKeysFromWhere: parentPkConstraint
      ? parentKeysFromOperationWheres(context.parentOperationsNotPreFetched(nestedOp.path), parentPkConstraint)
      : [],
    topLevelWhere,
    topLevelModelClient,
    relatedModelClient,
    preFetchResults,
    connectedRowWheres: connectedRowWheresAt(context, nestedOp.path),
    ...(keyColumns ? { select: keyColumns } : {}),
  });

  storeToOneResults(preFetchResults, nestedOp.path, results, pkConstraint.fields, keyColumns !== undefined);
  if (!parentsKnown) {
    markPathUnread(preFetchResults, nestedOp.path);
  }
};

const sameParent = (a: NestedOperationInfo, b: NestedOperationInfo): boolean =>
  a.parent?.operation === b.parent?.operation && a.parent?.element === b.parent?.element;

/**
 * The unique WHERE of the row a to-one `connect` or `connectOrCreate` names, keyed by its parent
 * row, for each parent row an `update`, `upsert` or `delete` next to it writes the linked row of:
 * Prisma links the named row first, so that row, not the one linked before the write, is the row
 * the write's before state is read from. A `connectOrCreate` whose row does not exist creates it,
 * and the read finds no row.
 */
const connectedRowWheresAt = (context: NestedPreFetchContext, path: string): Map<ParentRowIdentity, PreFetchRecord> => {
  const atPath = context.nestedOperations.filter((op) => op.path === path && !op.isList);
  const wheres = new Map<ParentRowIdentity, PreFetchRecord>();
  for (const connect of atPath.filter((op) => op.operation === 'connect' || op.operation === 'connectOrCreate')) {
    const [where] = targetWhereClauses(connect.operation, connect.data);
    const linkedRowWritten = atPath.some((op) => writesLinkedRow(op) && sameParent(op, connect));
    const parent = parentRowIdentityOf(connect.parent, context.preFetchResults, context.schemaMetadata);
    if (where && linkedRowWritten && parent !== undefined) {
      wheres.set(parent, where);
    }
  }
  return wheres;
};

/**
 * The key columns of an `update`'s row the operations below it need: its primary key, and
 * the fields each to-one relation below it links by (a to-many relation below it links by the
 * primary key)
 */
const keyColumnsOf = (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  childRelations: ReadonlySet<string>,
): Record<string, true> => {
  const { nestedOp, pkConstraint } = relation;
  const fields = new Set(pkConstraint.fields);
  for (const fieldName of childRelations) {
    const childField = findRelationField(context.schemaMetadata, nestedOp.relatedModel, fieldName);
    if (!childField || childField.isList) {
      continue;
    }
    for (const linkField of resolveToOneRelationLink(context.schemaMetadata, childField).parentFields) {
      fields.add(linkField);
    }
  }
  return Object.fromEntries([...fields].map((fieldName) => [fieldName, true as const]));
};

/**
 * Reads the key columns of the row each element of a to-many `update` whose before state is not
 * read names, when its WHERE names the row by a unique field other than the primary key, or a
 * to-one relation below it links by another column of that row (a foreign key on the row): one
 * read per element, so bounded by the caller's args. The key columns read are stored under the
 * element's WHERE, so the element's row is identified by it and the operations below it are read
 * and snapshotted under its key. A WHERE that names the primary key is enough for every other
 * relation below it.
 */
const identifyRowsNamedByElements = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  relatedModelClient: PreFetchModelClient,
  keyColumns: Record<string, true>,
): Promise<void> => {
  const { nestedOp, pkConstraint } = relation;
  const linksByPrimaryKey = Object.keys(keyColumns).length === pkConstraint.fields.length;
  const targets = namedTargets(nestedOp.operation, nestedOp.data).filter(
    ({ where }) => !(linksByPrimaryKey && primaryKeyNamedBy(where, pkConstraint)),
  );
  await readEachTarget(
    targets,
    async (where) => {
      const row = await relatedModelClient.findUnique({ where, select: keyColumns });
      preFetchLog('key columns of a to-many update row: path=%s found=%s', nestedOp.path, row !== null);
      if (row) {
        storeIdentifiedRow(context.preFetchResults, nestedOp.path, where, row, pkConstraint);
      }
    },
    targetReadFailureHandler(context, nestedOp),
  );
};

/**
 * Reads the key columns of the rows of an `update` whose before state is not read, so the
 * operations below it can be read and snapshotted under them: the read that identifies the rows
 * a write touches runs whatever `fetchBefore` says. A to-one `update`'s row is read under each of
 * its parent rows, a to-many `update`'s rows by the WHERE of each element.
 */
const identifyUpdatedRows = async (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
  childRelations: ReadonlySet<string>,
): Promise<void> => {
  const relation = resolveNestedRelation(context, nestedOp);
  const relatedModelClient = getPreFetchModelClient(
    context.prismaClient,
    nestedOp.relatedModel,
    context.auditedOmittedFields,
  );
  if (!relation || !relatedModelClient) {
    return;
  }
  const keyColumns = keyColumnsOf(context, relation, childRelations);
  await (nestedOp.isList
    ? identifyRowsNamedByElements(context, relation, relatedModelClient, keyColumns)
    : handleOneToOneRelation(context, relation, relatedModelClient, keyColumns));
};

const resolveToManyScopeInput = (
  context: NestedPreFetchContext,
  relation: NestedRelation,
): ToManyScopeInput | undefined => {
  const { topLevelWhere, topLevelModelClient, preFetchResults, resolvePkConstraint } = context;
  const { nestedOp, field, parentModel, pkConstraint } = relation;

  const parentPkConstraint = resolvePkConstraint(parentModel);
  if (!parentPkConstraint) {
    preFetchLog('parent model has no primary key, skipping pre-fetch: model=%s path=%s', parentModel, nestedOp.path);
    return undefined;
  }

  return {
    path: nestedOp.path,
    data: nestedOp.data,
    scope: resolveToManyRelationScope(context.schemaMetadata, field, parentModel, parentPkConstraint.fields),
    parentPkFields: parentPkConstraint.fields,
    topLevelWhere,
    topLevelModelClient,
    preFetchResults,
    pkConstraint,
    parentKeysFromWhere: parentKeysFromOperationWheres(
      context.parentOperationsNotPreFetched(nestedOp.path),
      parentPkConstraint,
    ),
  };
};

const handleOneToManyRelation = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  relatedModelClient: PreFetchModelClient,
): Promise<void> => {
  const scopeInput = resolveToManyScopeInput(context, relation);
  if (!scopeInput) {
    return;
  }

  await preFetchOneToManyRelation({
    ...scopeInput,
    operation: relation.nestedOp.operation,
    relatedModelClient,
    onTargetReadFailure: targetReadFailureHandler(context, relation.nestedOp),
  });
};

/** The `fetchBefore` operation (`update` or `delete`) whose setting decides whether a batch keyword reads whole rows */
const FETCH_BEFORE_OPERATION_OF_BATCH_KEYWORD: Record<NestedBatchKeyword, 'update' | 'delete'> = {
  updateMany: 'update',
  deleteMany: 'delete',
};

const recordBatchTargets = (
  batchTargets: NestedBatchTargets,
  path: string,
  keyword: NestedBatchKeyword,
  matched: ReadonlyMap<EntityIdentityKey, PreFetchRecord>,
): void => {
  const atPath = batchTargets.get(path) ?? new Map<NestedBatchKeyword, Map<EntityIdentityKey, PreFetchRecord>>();
  batchTargets.set(path, atPath);
  const known = atPath.get(keyword) ?? new Map<EntityIdentityKey, PreFetchRecord>();
  atPath.set(keyword, known);
  for (const [identity, key] of matched) {
    known.set(identity, key);
  }
};

/**
 * The discovery pass may find the same batch keyword at a path in more than one upsert branch,
 * so the rows each read matched are merged by identity.
 */
const handleToManyBatch = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  keyword: NestedBatchKeyword,
): Promise<void> => {
  const { nestedOp } = relation;

  const relatedModelClient = getPreFetchListClient(
    context.prismaClient,
    nestedOp.relatedModel,
    context.auditedOmittedFields,
  );
  if (!relatedModelClient) {
    preFetchLog('model client has no findMany: model=%s', nestedOp.relatedModel);
    return;
  }

  const scopeInput = resolveToManyScopeInput(context, relation);
  if (!scopeInput) {
    return;
  }

  const fetchBefore = context.shouldFetchBefore(
    nestedOp.relatedModel,
    FETCH_BEFORE_OPERATION_OF_BATCH_KEYWORD[keyword],
  );
  const matched = await preFetchToManyBatch({
    ...scopeInput,
    operation: keyword,
    relatedModelClient,
    fetchBefore,
    precedingWrites: nestedOp.precedingWrites,
    fieldNames: new Set(context.schemaMetadata.getAllFields(nestedOp.relatedModel).map((field) => field.name)),
  });
  recordBatchTargets(context.batchTargets, nestedOp.path, keyword, matched);
};
