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
  targetWhereClauses,
  type UpsertBranch,
} from '../../grammar/nested-operations.js';
import type { ParentRowIdentity } from '../../grammar/nested-state.js';
import {
  filterOperationsToPreFetch,
  type ShouldFetchBefore,
  sortByPathDepth,
} from '../../grammar/pre-fetch-selection.js';
import type {
  DMMFField,
  DMMFModel,
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
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
  isRecord,
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

type PrismaDMMF = PrismaNamespace['dmmf'];

export interface PreFetchCoordinatorDependencies {
  /** Prisma namespace given as the extension's `Prisma` option; read for the DMMF relation details */
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly shouldFetchBefore: ShouldFetchBefore;
  /**
   * Notified when a single nested operation's pre-fetch query fails. The rows the read left
   * unknown are recorded as `unavailable` (see pre-fetch-result-store.ts), and the caller's own
   * operation continues. Mirrors the top-level equivalent, `fetchBeforeState` in
   * pipeline/before-state.ts, which reports the same failure class through the same observer.
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
 * Resolves the model that declares the last segment of `path` by walking the DMMF from
 * `topLevelModel` (e.g. `'postTags.tag'` under Post resolves to PostTag).
 */
export const resolveParentModelFromPath = (
  path: string,
  topLevelModel: DMMFModel | undefined,
  dmmf: PrismaDMMF,
): DMMFModel | undefined => {
  if (!path.includes('.')) {
    return topLevelModel;
  }

  const pathSegments = path.split('.');
  const parentPathSegments = pathSegments.slice(0, -1);

  let currentModel = topLevelModel;

  for (const segment of parentPathSegments) {
    if (!currentModel) {
      break;
    }

    const segmentField = currentModel.fields.find((f) => f.name === segment);

    if (!segmentField || segmentField.kind !== 'object') {
      break;
    }

    currentModel = dmmf.datamodel.models.find((m) => m.name === segmentField.type);
  }

  return currentModel;
};

export const findDMMFField = (model: DMMFModel | undefined, fieldName: string): DMMFField | undefined => {
  if (!model) {
    return undefined;
  }

  return model.fields.find((f) => f.name === fieldName);
};

const categorizeRelationType = (
  field: DMMFField,
): {
  readonly isOneToOne: boolean;
  readonly isOwningSide: boolean;
} => {
  const isOneToOne = !field.isList;
  const isOwningSide = !!(field.relationFromFields && field.relationFromFields.length > 0);

  return { isOneToOne, isOwningSide };
};

/**
 * Reports a single nested operation's pre-fetch failure through the optional
 * `onPreFetchFailure` callback (see {@link PreFetchCoordinatorDependencies.onPreFetchFailure}).
 * A no-op when no callback is configured.
 */
const reportNestedPreFetchFailure = async (
  onPreFetchFailure: FailureSink['notify'] | undefined,
  nestedOp: NestedOperationInfo,
  error: unknown,
): Promise<void> => {
  if (!onPreFetchFailure) return;

  await onPreFetchFailure({
    phase: 'pre-fetch',
    modelName: nestedOp.relatedModel,
    operation: nestedOp.operation,
    params: nestedOp.data,
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
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  args: Record<string, unknown>,
  dependencies: PreFetchCoordinatorDependencies,
  topLevelUpsertBranch?: UpsertBranch,
): Promise<NestedPreFetch> => {
  const { Prisma, schemaMetadata, shouldFetchBefore, onPreFetchFailure } = dependencies;

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
    detachesUnderParent(Prisma, modelName, shouldFetchBefore, operation),
  );

  if (operationsToPreFetch.length === 0 && rowsToIdentify.size === 0) {
    return preFetch;
  }

  const sortedOperations = sortByPathDepth([...operationsToPreFetch, ...rowsToIdentify.keys()]);

  preFetchLog(
    'sorted operations by depth: %O',
    sortedOperations.map((op) => ({ path: op.path, depth: op.path.split('.').length })),
  );

  const dmmf: PrismaDMMF | undefined = Prisma.dmmf;

  if (!dmmf?.datamodel?.models) {
    preFetchLog('DMMF metadata not available, skipping pre-fetch');
    return preFetch;
  }

  const pkConstraintCache = new Map<string, UniqueConstraint | undefined>();

  const context: NestedPreFetchContext = {
    prismaClient,
    modelName,
    schemaMetadata,
    nestedOperations,
    dmmf,
    topLevelModel: dmmf.datamodel.models.find((m) => m.name === modelName),
    topLevelModelClient: getPreFetchModelClient(prismaClient, modelName),
    topLevelWhere: args.where,
    preFetchResults,
    batchTargets,
    identifiedRowKeys: new Map(),
    shouldFetchBefore,
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
      storeUnreadRows(
        preFetchResults,
        nestedOp.path,
        targetsNamedByWhere(nestedOp) ? targetWhereClauses(nestedOp.operation, nestedOp.data) : undefined,
        context.resolvePkConstraint(nestedOp.relatedModel),
      );
      preFetchLog('pre-fetch failed: path=%s error=%o', nestedOp.path, error);
      await reportNestedPreFetchFailure(onPreFetchFailure, nestedOp, error);
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
  Prisma: PrismaNamespace,
  modelName: string,
  shouldFetchBefore: ShouldFetchBefore,
  operation: NestedOperationInfo,
): boolean => {
  const link = relationLinkOf(Prisma, modelName, operation);
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
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  modelName: string;
  schemaMetadata: SchemaMetadata;
  /** Every nested operation the discovery pass detected */
  nestedOperations: readonly NestedOperationInfo[];
  dmmf: PrismaDMMF;
  topLevelModel: DMMFModel | undefined;
  topLevelModelClient: PreFetchModelClient | undefined;
  topLevelWhere: unknown;
  preFetchResults: NestedPreFetchResults;
  batchTargets: NestedBatchTargets;
  /**
   * The key columns read, by path, of the rows the elements of a to-many `update` whose before
   * state is not read name (see {@link identifyNamedRows})
   */
  identifiedRowKeys: Map<string, PreFetchRecord[]>;
  shouldFetchBefore: ShouldFetchBefore;
  resolvePkConstraint: (model: string) => UniqueConstraint | undefined;
  /** Operations at the parent path of `path` that were not pre-fetched; none for a direct child */
  parentOperationsNotPreFetched: (path: string) => NestedOperationInfo[];
}

interface NestedRelation {
  readonly nestedOp: NestedOperationInfo;
  readonly field: DMMFField;
  readonly parentModel: DMMFModel;
  readonly relatedModel: DMMFModel | undefined;
  readonly pkConstraint: UniqueConstraint;
}

const resolveNestedRelation = (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
): NestedRelation | undefined => {
  const { modelName, dmmf, topLevelModel, resolvePkConstraint } = context;

  const parentModel = resolveParentModelFromPath(nestedOp.path, topLevelModel, dmmf);
  const field = findDMMFField(parentModel, nestedOp.fieldName);
  if (!parentModel || !field) {
    preFetchLog('field not found in model: model=%s field=%s', parentModel?.name || modelName, nestedOp.fieldName);
    return undefined;
  }

  const pkConstraint = resolvePkConstraint(nestedOp.relatedModel);
  if (!pkConstraint) {
    preFetchLog('model has no primary key, skipping pre-fetch: model=%s path=%s', nestedOp.relatedModel, nestedOp.path);
    return undefined;
  }

  const relatedModel = dmmf.datamodel.models.find((m) => m.name === nestedOp.relatedModel);
  return { nestedOp, field, parentModel, relatedModel, pkConstraint };
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

  const relatedModelClient = getPreFetchModelClient(context.prismaClient, nestedOp.relatedModel);
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
    await handleConnectOrCreate(nestedOp, relatedModelClient, context.preFetchResults, relation.pkConstraint);
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
  nestedOp: NestedOperationInfo,
  relatedModelClient: PreFetchModelClient,
  preFetchResults: NestedPreFetchResults,
  pkConstraint: UniqueConstraint,
): Promise<void> => {
  const items = Array.isArray(nestedOp.data) ? nestedOp.data : [nestedOp.data];

  for (const item of items) {
    const whereClause = isRecord(item) ? item.where : undefined;

    if (!isRecord(whereClause)) {
      preFetchLog('connectOrCreate: no valid where clause, skipping: path=%s', nestedOp.path);
      continue;
    }

    const beforeRecord = await relatedModelClient.findUnique({ where: whereClause });
    storeReadResult(preFetchResults, nestedOp.path, whereClause, beforeRecord, pkConstraint);

    preFetchLog('connectOrCreate stored: path=%s found=%s', nestedOp.path, beforeRecord !== null);
  }
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
  const { nestedOp, field, parentModel, relatedModel, pkConstraint } = relation;
  const parentPkConstraint = resolvePkConstraint(parentModel.name);
  const { results, parentsKnown } = await preFetchOneToOneRelation({
    path: nestedOp.path,
    link: resolveToOneRelationLink(field, relatedModel),
    parentPkFields: parentPkConstraint?.fields ?? [],
    parentKeysFromWhere: parentPkConstraint ? parentKeysNotPreFetched(context, nestedOp.path, parentPkConstraint) : [],
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
 * The unique WHERE of the row a to-one `connect` names, keyed by its parent row, for each parent
 * row an `update` or `upsert` next to it writes the linked row of: Prisma links the named row
 * first, so that row, not the one linked before the write, is the row the write's before state
 * is read from
 */
const connectedRowWheresAt = (context: NestedPreFetchContext, path: string): Map<ParentRowIdentity, PreFetchRecord> => {
  const atPath = context.nestedOperations.filter((op) => op.path === path && !op.isList);
  const wheres = new Map<ParentRowIdentity, PreFetchRecord>();
  for (const connect of atPath.filter((op) => op.operation === 'connect')) {
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
  const { relatedModel, pkConstraint } = relation;
  const fields = new Set(pkConstraint.fields);
  for (const fieldName of childRelations) {
    const childField = findDMMFField(relatedModel, fieldName);
    if (!childField || childField.isList) {
      continue;
    }
    const childModel = context.dmmf.datamodel.models.find((model) => model.name === childField.type);
    for (const linkField of resolveToOneRelationLink(childField, childModel).parentFields) {
      fields.add(linkField);
    }
  }
  return Object.fromEntries([...fields].map((fieldName) => [fieldName, true as const]));
};

/**
 * Reads the key columns of the row each element of a to-many `update` whose before state is not
 * read names, when its WHERE names the row by a unique field other than the primary key, or a
 * to-one relation below it links by another column of that row (a foreign key on the row): one
 * read per element, so bounded by the caller's args. The read row is stored under the element's
 * WHERE, so the element's row is identified by it. A WHERE that names the primary key is enough
 * for every other relation below it.
 */
const identifyNamedRows = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  relatedModelClient: PreFetchModelClient,
  keyColumns: Record<string, true>,
): Promise<void> => {
  const { nestedOp, pkConstraint } = relation;
  const linksByPrimaryKey = Object.keys(keyColumns).length === pkConstraint.fields.length;
  const keys = context.identifiedRowKeys.get(nestedOp.path) ?? [];
  context.identifiedRowKeys.set(nestedOp.path, keys);
  for (const where of targetWhereClauses(nestedOp.operation, nestedOp.data)) {
    if (linksByPrimaryKey && primaryKeyNamedBy(where, pkConstraint)) {
      continue;
    }
    const row = await relatedModelClient.findUnique({ where, select: keyColumns });
    preFetchLog('key columns of a to-many update row: path=%s found=%s', nestedOp.path, row !== null);
    if (row) {
      keys.push(row);
      storeIdentifiedRow(
        context.preFetchResults,
        nestedOp.path,
        where,
        extractEntityIdOrUnresolved(row, pkConstraint.fields),
      );
    }
  }
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
  const relatedModelClient = getPreFetchModelClient(context.prismaClient, nestedOp.relatedModel);
  if (!relation || !relatedModelClient) {
    return;
  }
  const keyColumns = keyColumnsOf(context, relation, childRelations);
  await (nestedOp.isList
    ? identifyNamedRows(context, relation, relatedModelClient, keyColumns)
    : handleOneToOneRelation(context, relation, relatedModelClient, keyColumns));
};

/**
 * Parent rows of `path` that no pre-fetch result holds: the key columns read of the rows a
 * to-many `update` at the parent path names, ahead of the primary keys the WHERE of each
 * operation at the parent path that was not pre-fetched names, so the read row is the one kept
 */
const parentKeysNotPreFetched = (
  context: NestedPreFetchContext,
  path: string,
  parentPkConstraint: UniqueConstraint,
): PreFetchRecord[] => {
  const parentPath = parentPathOf(path);
  const readKeys = parentPath === undefined ? undefined : context.identifiedRowKeys.get(parentPath);
  return [
    ...(readKeys ?? []),
    ...parentKeysFromOperationWheres(context.parentOperationsNotPreFetched(path), parentPkConstraint),
  ];
};

const resolveToManyScopeInput = (
  context: NestedPreFetchContext,
  relation: NestedRelation,
): ToManyScopeInput | undefined => {
  const { topLevelWhere, topLevelModelClient, preFetchResults, resolvePkConstraint } = context;
  const { nestedOp, field, parentModel, relatedModel, pkConstraint } = relation;

  const parentPkConstraint = resolvePkConstraint(parentModel.name);
  if (!parentPkConstraint) {
    preFetchLog(
      'parent model has no primary key, skipping pre-fetch: model=%s path=%s',
      parentModel.name,
      nestedOp.path,
    );
    return undefined;
  }

  return {
    path: nestedOp.path,
    data: nestedOp.data,
    scope: resolveToManyRelationScope(field, parentModel.name, relatedModel, parentPkConstraint.fields),
    parentPkFields: parentPkConstraint.fields,
    topLevelWhere,
    topLevelModelClient,
    preFetchResults,
    pkConstraint,
    parentKeysFromWhere: parentKeysNotPreFetched(context, nestedOp.path, parentPkConstraint),
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

  await preFetchOneToManyRelation({ ...scopeInput, operation: relation.nestedOp.operation, relatedModelClient });
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

  const relatedModelClient = getPreFetchListClient(context.prismaClient, nestedOp.relatedModel);
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
  });
  recordBatchTargets(context.batchTargets, nestedOp.path, keyword, matched);
};
