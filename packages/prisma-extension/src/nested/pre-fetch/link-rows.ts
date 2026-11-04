/**
 * Rows a nested write may re-link, read before the write
 *
 * On a relation whose foreign key lives on the related model, a nested `connect`, `set`,
 * `disconnect` or a `connectOrCreate` that connects rewrites the foreign key of existing related
 * rows: the rows it names are attached to the parent row, and the rows a `set` leaves out, or the
 * row a to-one `connect`, `create`, `connectOrCreate` or `disconnect` replaces or unlinks, are
 * detached from it. Each such row is audited as an update of that row, whose before state is read
 * here: one related-model query per path, whole rows, for every row the writes at the path name
 * by unique WHERE and every row attached under the parent rows a write detaches rows from. A
 * `connectOrCreate` row was already read by its own pre-fetch.
 *
 * The read runs only when `fetchBefore` reads the before state of updates of the related model:
 * the record exists to tell the old foreign key, which nothing else holds. A failed read is
 * reported like any nested pre-fetch failure and leaves the caller's operation running; the writes
 * whose detached rows it, or the failed read of their parent row, leaves unknown are named so that
 * the collection reports them as left without a record.
 *
 * @module nested/pre-fetch/link-rows
 */

import type { BeforeState, FailureSink } from '@kuruwic/db-audit-core';
import {
  getRowKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  namedTargets,
} from '../../grammar/nested-operations.js';
import { filterOperationsToPreFetch, type ShouldFetchBefore } from '../../grammar/pre-fetch-selection.js';
import type { PrismaHandle } from '../../internal-types.js';
import type { SchemaMetadata } from '../../schema/types.js';
import type { AuditedOmittedFields } from '../../utils/audited-omitted-fields.js';
import { uniqueWhereAsFilter } from '../../utils/compound-where.js';
import { preFetchLog } from '../../utils/debug.js';
import { toError } from '../../utils/to-error.js';
import { getPreFetchListClient, getPreFetchModelClient } from './model-client.js';
import {
  parentBeforeStateOf,
  parentKeyOf,
  parentKeysFromOperationWheres,
  parentPathOf,
  parentRowIdentityOf,
  resolveParentRows,
} from './parent-rows.js';
import { type RelationLink, relationLinkOf } from './relation-link.js';

type Row = Record<string, unknown>;

/** A link whose foreign key lives on the related model */
export type RelatedSideLink = Extract<RelationLink, { side: 'related' }>;

/** A nested write that may rewrite the foreign key of existing related rows */
export interface LinkWrite {
  readonly operation: NestedOperationInfo;
  /** The unique WHEREs of the rows it attaches (or, for a to-many `disconnect`, detaches) by name */
  readonly named: readonly Row[];
  /** It detaches the rows its parent row held before the write */
  readonly detaches: boolean;
}

/** What was read before the write for the link writes at one path */
export interface LinkPathRead {
  readonly relatedModel: string;
  readonly keyFields: readonly string[];
  readonly link: RelatedSideLink;
  readonly writes: readonly LinkWrite[];
  /** The rows the read found, whole: their before state */
  readonly rows: readonly Row[];
  /**
   * The values the parent row of each write held in the link's `references` before the write;
   * absent when that parent row is unknown or the operation creates it
   */
  readonly parentKeys: ReadonlyMap<NestedOperationInfo, Row>;
  /** The read failed: the named rows are audited without a before state, the detached rows cannot be told */
  readonly failed: boolean;
  /**
   * The detaching writes whose parent row held rows before the write that cannot be told: the read
   * failed, or the parent row's own read did, so its key is unknown. Not a write whose parent row
   * the operation creates, which held none.
   */
  readonly undeterminedDetaches: ReadonlySet<NestedOperationInfo>;
}

/** The link reads of an operation, keyed by path */
export type LinkReads = ReadonlyMap<string, LinkPathRead>;

/**
 * Undefined for a write that rewrites no existing row's foreign key. On an optional foreign key, a
 * `set` unlinks the rows it does not name, and a to-one `connect`, `create`, `connectOrCreate` or
 * `disconnect` unlinks the row the parent held; on a required one Prisma rejects any write that
 * would unlink a row.
 */
export const linkWriteOf = (operation: NestedOperationInfo, link: RelatedSideLink): LinkWrite | undefined => {
  const named = () => namedTargets(operation.operation, operation.data).map((target) => target.where);
  const replacesToOne = !operation.isList && link.optional;
  switch (operation.operation) {
    case 'connect':
      return { operation, named: named(), detaches: replacesToOne };
    case 'set':
      return { operation, named: named(), detaches: link.optional };
    case 'disconnect':
      if (operation.isList) {
        return { operation, named: named(), detaches: false };
      }
      return replacesToOne ? { operation, named: [], detaches: true } : undefined;
    case 'connectOrCreate':
      return { operation, named: [], detaches: replacesToOne };
    case 'create':
      return replacesToOne ? { operation, named: [], detaches: true } : undefined;
    default:
      return undefined;
  }
};

export interface ReadLinkRowsInput {
  readonly prismaClient: PrismaHandle;
  readonly modelName: string;
  readonly topLevelWhere: unknown;
  /** The nested operations the operation executes */
  readonly nestedOperations: readonly NestedOperationInfo[];
  readonly nestedPreFetchResults: NestedPreFetchResults;
}

export interface ReadLinkRowsDependencies {
  readonly schemaMetadata: SchemaMetadata;
  readonly shouldFetchBefore: ShouldFetchBefore;
  readonly auditedOmittedFields: AuditedOmittedFields;
  readonly onPreFetchFailure?: FailureSink['notify'];
}

interface PathWrites {
  readonly link: RelatedSideLink;
  readonly writes: LinkWrite[];
}

const linkWritesByPath = (input: ReadLinkRowsInput, deps: ReadLinkRowsDependencies): Map<string, PathWrites> => {
  const byPath = new Map<string, PathWrites>();
  for (const operation of input.nestedOperations) {
    const link = relationLinkOf(deps.schemaMetadata, input.modelName, operation);
    if (link?.side !== 'related' || !deps.shouldFetchBefore(operation.relatedModel, 'update')) {
      continue;
    }
    const write = linkWriteOf(operation, link);
    if (!write) {
      continue;
    }
    const atPath = byPath.get(operation.path) ?? { link, writes: [] };
    byPath.set(operation.path, atPath);
    atPath.writes.push(write);
  }
  return byPath;
};

const readParentKeys = async (
  input: ReadLinkRowsInput,
  deps: ReadLinkRowsDependencies,
  path: string,
  { link, writes }: PathWrites,
): Promise<Map<NestedOperationInfo, Row>> => {
  const parentKeyConstraint = getRowKeyConstraint(deps.schemaMetadata, link.parentModel);
  if (!parentKeyConstraint) {
    return new Map();
  }
  const parentPath = parentPathOf(path);
  const preFetched = new Set(filterOperationsToPreFetch(input.nestedOperations, deps.shouldFetchBefore));
  const notPreFetched = input.nestedOperations.filter(
    (operation) => operation.path === parentPath && !preFetched.has(operation),
  );
  const { rows } = await resolveParentRows({
    path,
    parentFields: link.references,
    parentKeyFields: parentKeyConstraint.fields,
    topLevelWhere: input.topLevelWhere,
    topLevelModelClient: getPreFetchModelClient(input.prismaClient, input.modelName, deps.auditedOmittedFields),
    preFetchResults: input.nestedPreFetchResults,
    parentKeysFromWhere: parentKeysFromOperationWheres(notPreFetched, parentKeyConstraint),
  });
  const keys = new Map<NestedOperationInfo, Row>();
  for (const { operation } of writes) {
    const identity = parentRowIdentityOf(operation.parent, input.nestedPreFetchResults, deps.schemaMetadata);
    const parentRow = identity === undefined ? undefined : rows.find((row) => row.identity === identity)?.row;
    const key = parentRow ? parentKeyOf(parentRow, link.references) : undefined;
    if (key) {
      keys.set(operation, key);
    }
  }
  return keys;
};

/**
 * Rejects a link that names fewer referenced fields than foreign-key fields: `attachedFilter`
 * would filter the missing ones by `undefined`, which Prisma reads as no filter, and match every
 * row of the related model.
 */
const assertReferencesComplete = (link: RelatedSideLink): void => {
  if (link.references.length < link.fields.length) {
    throw new Error(
      `[@prisma-audit] Cannot read the rows linked to a "${link.parentModel}" row: the foreign key ` +
        `(${link.fields.map((field) => `"${field}"`).join(', ')}) references ` +
        `${link.references.length} of ${link.fields.length} fields in the schema metadata`,
    );
  }
};

/**
 * Whether the row a nested operation writes may exist before the write, given its before state:
 * not the row a create inserts, nor the row an upsert or connectOrCreate, whose row is always
 * read, found absent. The row an update writes exists, whether or not its before state is read.
 */
const mayExistBefore = (operation: NestedOperationInfo, before: BeforeState): boolean => {
  switch (operation.operation) {
    case 'create':
      return false;
    case 'upsert':
    case 'connectOrCreate':
      return before.kind !== 'none';
    default:
      return true;
  }
};

/**
 * The detaching writes among `writes` whose parent row may have held rows the read did not find:
 * after a failed read, every one whose parent row may exist (not the top-level row of a create,
 * see {@link mayExistBefore} for a nested one); else those whose parent row's read failed, which
 * left its key unknown
 */
const undeterminedDetachesOf = (
  input: ReadLinkRowsInput,
  deps: ReadLinkRowsDependencies,
  { writes, parentKeys, failed }: Pick<LinkPathRead, 'writes' | 'parentKeys' | 'failed'>,
): Set<NestedOperationInfo> => {
  const undetermined = (write: LinkWrite): boolean => {
    if (!write.detaches || parentKeys.has(write.operation)) {
      return false;
    }
    const { parent } = write.operation;
    if (!parent) {
      return failed && input.topLevelWhere !== undefined;
    }
    const before = parentBeforeStateOf(parent, input.nestedPreFetchResults, deps.schemaMetadata);
    return failed ? mayExistBefore(parent.operation, before) : before.kind === 'unavailable';
  };
  return new Set(writes.filter(undetermined).map((write) => write.operation));
};

/** The foreign key of the link holding `parentKey`, as a filter on the related model */
export const attachedFilter = (link: RelatedSideLink, parentKey: Row): Row =>
  Object.fromEntries(link.fields.map((field, index) => [field, parentKey[link.references[index] ?? '']]));

const readPath = async (
  input: ReadLinkRowsInput,
  deps: ReadLinkRowsDependencies,
  path: string,
  pathWrites: PathWrites,
): Promise<LinkPathRead | undefined> => {
  const { link, writes } = pathWrites;
  const [first] = writes;
  const keyFields = first ? getRowKeyConstraint(deps.schemaMetadata, first.operation.relatedModel)?.fields : undefined;
  const client = first
    ? getPreFetchListClient(input.prismaClient, first.operation.relatedModel, deps.auditedOmittedFields)
    : undefined;
  if (!first || !keyFields || !client) {
    return undefined;
  }
  const relatedModel = first.operation.relatedModel;
  const base = { relatedModel, keyFields, link, writes };
  try {
    assertReferencesComplete(link);
    const parentKeys = await readParentKeys(input, deps, path, pathWrites);
    const fieldNames = new Set(deps.schemaMetadata.getAllFields(relatedModel).map((field) => field.name));
    const filters = writes.flatMap((write) => {
      const parentKey = parentKeys.get(write.operation);
      return [
        ...write.named.map((where) => uniqueWhereAsFilter(where, fieldNames)),
        ...(write.detaches && parentKey ? [attachedFilter(link, parentKey)] : []),
      ];
    });
    const rows = filters.length > 0 ? await client.findMany({ where: { OR: filters } }) : [];
    preFetchLog('link rows read: path=%s rows=%d', path, rows.length);
    const undeterminedDetaches = undeterminedDetachesOf(input, deps, { writes, parentKeys, failed: false });
    return { ...base, rows, parentKeys, failed: false, undeterminedDetaches };
  } catch (error) {
    preFetchLog('link rows read failed: path=%s error=%o', path, error);
    await deps.onPreFetchFailure?.({
      phase: 'pre-fetch',
      modelName: relatedModel,
      operation: first.operation.operation,
      params: first.operation.data,
      error: toError(error),
    });
    const parentKeys = new Map<NestedOperationInfo, Row>();
    const undeterminedDetaches = undeterminedDetachesOf(input, deps, { writes, parentKeys, failed: true });
    return { ...base, rows: [], parentKeys, failed: true, undeterminedDetaches };
  }
};

export const readLinkRows = async (input: ReadLinkRowsInput, deps: ReadLinkRowsDependencies): Promise<LinkReads> => {
  const reads = new Map<string, LinkPathRead>();
  for (const [path, pathWrites] of linkWritesByPath(input, deps)) {
    const read = await readPath(input, deps, path, pathWrites);
    if (read) {
      reads.set(path, read);
    }
  }
  return reads;
};
