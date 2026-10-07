/**
 * Nested mutation event collection
 *
 * Attributes the rows an executed operation returned to the nested operations that wrote them,
 * walking the result from the top-level row down one level at a time, each written path once for
 * all its parent rows. The rows a relation holds under a returned row are candidates only for the
 * operations nested under the operations that row was attributed to, so a row below a row the
 * operation did not write is not audited, and a row is attributed once however many elements of a
 * list carry a write at its path. One mutation event is yielded per row an operation wrote.
 *
 * A to-many relation is returned whole, so a row there is an operation's only when the write set
 * says so: a row a target locates belongs to that operation (by the primary key of the row read
 * ahead of the operation, or else by its unique WHERE; see `NestedRowLocator`), and a row several
 * targets locate is recorded once, for the first whose write is audited from the row; a row that
 * matches no target and did not exist before the operation was inserted: it is recorded for the first
 * operation nested under its parent that inserts rows, and attributed to every such operation,
 * since which of them inserted it cannot be told; any other row is a sibling and yields nothing. The
 * rows the operation wrote at a path that the result does not hold are read once for the path (see
 * `rows-not-in-result.ts`). A `deleteMany` yields one delete event per row its filter matched in the
 * read ahead of the operation. A to-one relation holds one related row under its parent row: the
 * row of the operation nested there that names it by unique WHERE, else of the one that writes the
 * related row of its parent (a connectOrCreate whose WHERE found no row created it). The
 * foreign-key changes of `connect` / `set` / `disconnect` come from `link-changes.ts`.
 */

import type { BeforeState, MutationEvent } from '@kuruwic/db-audit-core';
import {
  deserializeEntityId,
  getPrimaryKeyConstraint,
  linksNamedRows,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  type NestedPreFetchResults,
  namedTargets,
  relationRowsOf,
  targetWhereClauses,
} from '../../grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../grammar/nested-state.js';
import { AUDIT_ACTION } from '../../grammar/operations.js';
import type { ShouldFetchBefore } from '../../grammar/pre-fetch-selection.js';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import type { AuditedOmittedFields } from '../../utils/audited-omitted-fields.js';
import {
  relationNodeOf,
  relationSelectionOf,
  restrictsRows,
  writtenRelationsInclude,
} from '../../utils/audited-selection.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { matchesUniqueWhere } from '../../utils/compound-where.js';
import { nestedLog } from '../../utils/debug.js';
import { extractEntityIdentity, sameKeyValue } from '../../utils/id-generation.js';
import { attachedFilter, type LinkReads } from '../pre-fetch/link-rows.js';
import { getPreFetchListClient } from '../pre-fetch/model-client.js';
import {
  keyNamedByWhere,
  parentKeyOf,
  parentRowAsStoredOf,
  parentRowIdentityOf,
  writesLinkedRow,
} from '../pre-fetch/parent-rows.js';
import type { PreExistingRows } from '../pre-fetch/pre-existing-rows.js';
import { preFetchedStateNamedBy, preFetchedStateUnder } from '../pre-fetch/pre-fetch-result-store.js';
import { relationLinkOf } from '../pre-fetch/relation-link.js';
import { resolveToManyPath } from '../pre-fetch/to-many-path.js';
import type { CollectedNestedRecord } from './collected-record.js';
import {
  collectToManyDeleteRecords,
  collectToOneDeleteRecords,
  type LinkedRowNamedBy,
  type UnresolvedDeleteEntityIdReporter,
} from './delete-handler.js';
import { identityOf } from './event-fields.js';
import { collectLinkChanges } from './link-changes.js';
import { type ParentAtPath, readRowsNotInResult } from './rows-not-in-result.js';
import { resolveNestedRowState } from './state-resolver.js';
import { insertsRows, type NestedWriteSet, type NestedWriteSets, type NestedWriteTarget } from './write-set.js';

type Row = Record<string, unknown>;

export interface NestedEventCollectorDependencies {
  /** Prisma namespace given as the extension's `Prisma` option; the top-level collector reads its `skip` and `Decimal` */
  Prisma: PrismaNamespace;
  schemaMetadata: SchemaMetadata;
  shouldFetchBefore: ShouldFetchBefore;
  auditedOmittedFields: AuditedOmittedFields;
  /**
   * Notified when a nested delete's primary key cannot be resolved (see `delete-handler.ts`);
   * that entry is skipped instead of being recorded with a partial or guessed key. Optional:
   * when omitted, the entry is still skipped, just not reported.
   */
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter;
}

export interface NestedEventCollectionInput {
  modelName: string;
  /** The args the operation ran with: their `include` / `select` decide which rows the result holds */
  args: Record<string, unknown>;
  result: unknown;
  topLevelBefore: BeforeState;
  /** Client the operation ran on; reads the nested rows the result does not hold */
  client: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  nestedPreFetchResults: NestedPreFetchResults;
  /** The nested operations the operation executed, in detection order */
  nestedOperations: readonly NestedOperationInfo[];
  writeSets: NestedWriteSets;
  preExistingRows: PreExistingRows;
  /** The rows the link writes may re-link, read before the operation */
  linkReads: LinkReads;
}

/**
 * The operations that may have written a returned row and the element of their data that wrote
 * it. A row a write names has one operation and the element that names it. A row inserted
 * without a name cannot be told from the rows the other inserting operations under its parent
 * wrote (the elements of a list create, the elements under every element of one), so it carries
 * all of them, with `element` undefined: the operations nested under any element of any of them
 * are candidates below it.
 */
interface RowAttribution {
  readonly operations: readonly NestedOperationInfo[];
  readonly element: number | undefined;
}

/**
 * A row of the walk: the operations it was attributed to (none for the top-level row), and the
 * selection node it was read with, which tells whether the relations below it hold every row
 */
interface WalkedRow {
  readonly row: Row;
  readonly attribution: RowAttribution | undefined;
  readonly selection: Row;
}

interface AttributedRow extends WalkedRow {
  readonly attribution: RowAttribution;
}

interface SourcedRow {
  readonly row: Row;
  readonly selection: Row;
}

interface CollectionWalk {
  readonly input: NestedEventCollectionInput;
  readonly deps: NestedEventCollectorDependencies;
  readonly pkConstraints: ReadonlyMap<string, UniqueConstraint | undefined>;
  /** The records each operation is attributed, in the order the walk reaches its rows */
  readonly records: Map<NestedOperationInfo, CollectedNestedRecord[]>;
  /** The rows already attributed at each path */
  readonly claimed: Map<string, Set<Row>>;
  /** The to-one operations already attributed a row */
  readonly assigned: Set<NestedOperationInfo>;
}

const toEvent = (
  record: CollectedNestedRecord,
  nestedOp: NestedOperationInfo,
  pkConstraint: UniqueConstraint,
): MutationEvent => ({
  model: record.relatedModel,
  identity: identityOf(record.entity, pkConstraint.fields, { model: record.relatedModel, path: nestedOp.path }),
  action: record.action,
  before: record.beforeState,
  after: record.action === AUDIT_ACTION.DELETE ? record.rowAsWritten : record.entity,
  origin: { path: nestedOp.path, op: nestedOp.operation },
});

const isDelete = (nestedOp: NestedOperationInfo): boolean =>
  nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany';

/**
 * Whether `nestedOp` was detected in the data that wrote a row attributed `attribution`; the
 * top-level row has no attribution
 */
const isNestedUnder = (nestedOp: NestedOperationInfo, attribution: RowAttribution | undefined): boolean => {
  if (!attribution) {
    return nestedOp.parent === undefined;
  }
  const { parent } = nestedOp;
  return (
    parent !== undefined &&
    attribution.operations.includes(parent.operation) &&
    (attribution.element === undefined || parent.element === attribution.element)
  );
};

const record = (walk: CollectionWalk, nestedOp: NestedOperationInfo, row: Row, before: BeforeState): void => {
  const resolved = resolveNestedRowState(nestedOp, before, walk.deps.shouldFetchBefore);
  if (resolved === undefined) {
    nestedLog(
      'no audit log for the %s row at path=%s (connected, or its target could not be read)',
      nestedOp.operation,
      nestedOp.path,
    );
    return;
  }
  const records = walk.records.get(nestedOp) ?? [];
  walk.records.set(nestedOp, records);
  records.push({
    entity: row,
    action: resolved.action,
    beforeState: resolved.beforeState,
    relatedModel: nestedOp.relatedModel,
  });
};

const claimedAt = (walk: CollectionWalk, path: string): Set<Row> => {
  const claimed = walk.claimed.get(path) ?? new Set<Row>();
  walk.claimed.set(path, claimed);
  return claimed;
};

const isLocatedBy = (row: Row, target: NestedWriteTarget): boolean => matchesUniqueWhere(row, target.locator.where);

const targetOf = (row: Row, targets: readonly NestedWriteTarget[]): NestedWriteTarget | undefined =>
  targets.find((target) => isLocatedBy(row, target));

/**
 * The target a row is recorded for. Several writes at a path can name one row (a `connect` next
 * to an `update` of it); the row is recorded once, for the first of them whose write is audited
 * from the row's before state and its state after the write, so that one record carries every
 * change the writes made. A row only linking writes name yields no record here.
 */
const recordedTargetOf = (
  walk: CollectionWalk,
  row: Row,
  targets: readonly NestedWriteTarget[],
): NestedWriteTarget | undefined => {
  const locating = targets.filter((target) => isLocatedBy(row, target));
  return (
    locating.find(
      (target) => resolveNestedRowState(target.operation, target.before, walk.deps.shouldFetchBefore) !== undefined,
    ) ?? locating[0]
  );
};

/**
 * The before state of a row a target locates: what the target's own read found, else, when that
 * read found no row under the parent (a row a `connect` next to the write moves in from another
 * parent), the row as the read of the rows the path's link writes may re-link found it
 */
const locatedBeforeState = (walk: CollectionWalk, path: string, row: Row, before: BeforeState): BeforeState => {
  const read = walk.input.linkReads.get(path);
  if (before.kind !== 'none' || !read) {
    return before;
  }
  const identity = extractEntityIdentity(row, read.pkFields);
  const linked = read.rows.find((candidate) => extractEntityIdentity(candidate, read.pkFields) === identity);
  return linked ? { kind: 'captured', row: linked } : before;
};

const attributeToManyRows = (
  walk: CollectionWalk,
  relation: CandidateRelation,
  rows: readonly SourcedRow[],
): AttributedRow[] => {
  const { path, candidates, pkFields } = relation;
  const writeSet = writeSetAt(walk, path);
  const ownTargets = ownTargetsOf(writeSet, candidates);
  const claimed = claimedAt(walk, path);
  const attributed: AttributedRow[] = [];

  for (const { row, selection } of rows) {
    const target = recordedTargetOf(walk, row, ownTargets);
    if (target) {
      claimed.add(row);
      record(walk, target.operation, row, locatedBeforeState(walk, path, row, target.before));
      attributed.push({ row, selection, attribution: { operations: [target.operation], element: target.element } });
    }
  }

  const inserting = insertingCandidatesOf(candidates, ownTargets);
  const [recorded] = inserting;
  if (!recorded) {
    return attributed;
  }
  const preExisting = walk.input.preExistingRows.get(path);
  const origin = { model: recorded.relatedModel, path };
  for (const { row, selection } of rows) {
    if (claimed.has(row) || targetOf(row, writeSet.targets) || preExisting?.has(identityOf(row, pkFields, origin))) {
      continue;
    }
    claimed.add(row);
    record(walk, recorded, row, NO_BEFORE_STATE);
    attributed.push({ row, selection, attribution: { operations: inserting, element: undefined } });
  }
  return attributed;
};

const writeSetAt = (walk: CollectionWalk, path: string): NestedWriteSet =>
  walk.input.writeSets.get(path) ?? { targets: [], createsPending: false };

const ownTargetsOf = (writeSet: NestedWriteSet, candidates: readonly NestedOperationInfo[]): NestedWriteTarget[] =>
  writeSet.targets.filter((target) => candidates.includes(target.operation));

const insertingCandidatesOf = (
  candidates: readonly NestedOperationInfo[],
  targets: readonly NestedWriteTarget[],
): NestedOperationInfo[] =>
  candidates.filter((candidate) =>
    insertsRows(
      candidate,
      targets.filter((target) => target.operation === candidate),
    ),
  );

const namesRowByWhere = (nestedOp: NestedOperationInfo): boolean =>
  linksNamedRows(nestedOp.operation) || nestedOp.operation === 'connectOrCreate';

/** The operation a to-one row is recorded for, and the operations that may have written it */
interface ToOneWriter {
  readonly recorded: NestedOperationInfo;
  readonly attribution: RowAttribution;
}

/**
 * Whether a to-one candidate writes the related row of its parent without naming it by unique
 * WHERE: a create, update or upsert, or a connectOrCreate whose WHERE found no row before the
 * write, which created its row from `create` data that need not match the WHERE.
 */
const writesUnnamedRow = (walk: CollectionWalk, candidate: NestedOperationInfo): boolean =>
  !namesRowByWhere(candidate) ||
  (candidate.operation === 'connectOrCreate' && toOneBeforeState(walk, candidate).kind === 'none');

/**
 * The candidate that names the row by unique WHERE, together with an `update` or `upsert` next to
 * it, which Prisma applies to the row the candidate linked; else the candidates that write the
 * related row of their parent without naming it. Those cannot be told apart when the elements of
 * a list insert each write one, so the row is recorded for one not recorded yet, and every one of
 * them may have written it. Of a named row's writers, the row is recorded for the first whose
 * write is audited from the row's before state and its state after the write, so that one record
 * carries every change they made.
 */
const toOneWriterOf = (
  walk: CollectionWalk,
  row: Row,
  candidates: readonly NestedOperationInfo[],
): ToOneWriter | undefined => {
  const named = candidates.find(
    (candidate) =>
      namesRowByWhere(candidate) &&
      targetWhereClauses(candidate.operation, candidate.data).some((where) => matchesUniqueWhere(row, where)),
  );
  if (named) {
    const writing = [named, ...candidates.filter(writesLinkedRow)];
    const recorded =
      writing.find(
        (candidate) =>
          resolveNestedRowState(candidate, toOneBeforeState(walk, candidate), walk.deps.shouldFetchBefore) !==
          undefined,
      ) ?? named;
    return { recorded, attribution: { operations: writing, element: 0 } };
  }
  const writers = candidates.filter((candidate) => writesUnnamedRow(walk, candidate));
  const recorded = writers.find((candidate) => !walk.assigned.has(candidate)) ?? writers[0];
  return recorded && { recorded, attribution: { operations: writers, element: 0 } };
};

/**
 * The before state of the row a to-one operation wrote: a connectOrCreate's row as its unique
 * WHERE named it, an update's or upsert's as the related row of the row its parent element names
 * (the read that also decided the upsert's branch); none for a create.
 */
const toOneBeforeState = (walk: CollectionWalk, nestedOp: NestedOperationInfo): BeforeState => {
  const { nestedPreFetchResults } = walk.input;
  if (nestedOp.operation === 'create') {
    return NO_BEFORE_STATE;
  }
  if (namesRowByWhere(nestedOp)) {
    const [where] = targetWhereClauses(nestedOp.operation, nestedOp.data);
    return where ? preFetchedStateNamedBy(nestedPreFetchResults, nestedOp.path, where) : NO_BEFORE_STATE;
  }
  const parent = parentRowIdentityOf(nestedOp.parent, nestedPreFetchResults, walk.deps.schemaMetadata);
  return preFetchedStateUnder(nestedPreFetchResults, nestedOp.path, parent);
};

const attributeToOneRow = (walk: CollectionWalk, relation: CandidateRelation, related: SourcedRow): AttributedRow[] => {
  const writer = toOneWriterOf(walk, related.row, relation.candidates);
  if (!writer) {
    return [];
  }
  walk.assigned.add(writer.recorded);
  record(walk, writer.recorded, related.row, toOneBeforeState(walk, writer.recorded));
  return [{ ...related, attribution: writer.attribution }];
};

/** A relation written below one attributed row: its path and the operations nested there */
interface CandidateRelation {
  readonly fieldName: string;
  readonly path: string;
  readonly isList: boolean;
  readonly pkFields: readonly string[];
  readonly candidates: NestedOperationInfo[];
}

const candidateRelations = (walk: CollectionWalk, attribution: RowAttribution | undefined): CandidateRelation[] => {
  const byPath = new Map<string, CandidateRelation>();
  for (const nestedOp of walk.input.nestedOperations) {
    const pkConstraint = walk.pkConstraints.get(nestedOp.path);
    // A delete or disconnect leaves no row under the parent to attribute
    if (
      isDelete(nestedOp) ||
      nestedOp.operation === 'disconnect' ||
      !pkConstraint ||
      !isNestedUnder(nestedOp, attribution)
    ) {
      continue;
    }
    const relation = byPath.get(nestedOp.path) ?? {
      fieldName: nestedOp.fieldName,
      path: nestedOp.path,
      isList: nestedOp.isList,
      pkFields: pkConstraint.fields,
      candidates: [],
    };
    byPath.set(nestedOp.path, relation);
    relation.candidates.push(nestedOp);
  }
  return [...byPath.values()];
};

interface RelationBelow {
  readonly parent: WalkedRow;
  readonly relation: CandidateRelation;
}

const relationsBelow = (walk: CollectionWalk, rows: readonly WalkedRow[]): Map<string, RelationBelow[]> => {
  const byPath = new Map<string, RelationBelow[]>();
  for (const parent of rows) {
    for (const relation of candidateRelations(walk, parent.attribution)) {
      const atPath = byPath.get(relation.path) ?? [];
      byPath.set(relation.path, atPath);
      atPath.push({ parent, relation });
    }
  }
  return byPath;
};

const heldRowsOf = (parent: WalkedRow, relation: CandidateRelation): SourcedRow[] => {
  const entry = relationSelectionOf(parent.selection, relation.fieldName);
  const selection = relationNodeOf(entry);
  return relationRowsOf(parent.row, { name: relation.fieldName, isList: relation.isList }).map((row) => ({
    row,
    selection,
  }));
};

/**
 * Whether an update `target` wrote a row that existed before the operation: such a row is audited
 * from its after state, which only the result or a read after the write holds.
 */
const updatesExistingRow = (target: NestedWriteTarget): boolean => {
  const { operation } = target.operation;
  return (
    operation === 'update' ||
    operation === 'updateMany' ||
    (operation === 'upsert' && target.before.kind === 'captured')
  );
};

const parentAtPath = (walk: CollectionWalk, { parent, relation }: RelationBelow, held: readonly SourcedRow[]) => {
  const ownTargets = ownTargetsOf(writeSetAt(walk, relation.path), relation.candidates);
  const restricted = restrictsRows(relationSelectionOf(parent.selection, relation.fieldName));
  return {
    row: parent.row,
    rows: held.map(({ row }) => row),
    absentTargets: ownTargets.filter(
      (target) => updatesExistingRow(target) && !held.some(({ row }) => isLocatedBy(row, target)),
    ),
    insertsHidden: restricted && insertingCandidatesOf(relation.candidates, ownTargets).length > 0,
  } satisfies ParentAtPath;
};

/** The rows the operation wrote at a to-many path that the result does not hold, in the order of `below` */
const rowsNotInResult = async (
  walk: CollectionWalk,
  below: readonly RelationBelow[],
  held: readonly SourcedRow[][],
): Promise<SourcedRow[][]> => {
  const [first] = below;
  if (!first) {
    return [];
  }
  const { path, pkFields, candidates } = first.relation;
  const [operation] = candidates;
  const parents = below.map((entry, index) => parentAtPath(walk, entry, held[index] ?? []));
  if (parents.every((parent) => parent.absentTargets.length === 0 && !parent.insertsHidden)) {
    return parents.map(() => []);
  }
  const { input, deps } = walk;
  const relatedModel = operation?.relatedModel ?? '';
  const client = getPreFetchListClient(input.client, relatedModel, deps.auditedOmittedFields);
  if (!client) {
    throw new Error(
      `[@prisma-audit] Cannot read the nested rows at path "${path}": no model client for "${relatedModel}"`,
    );
  }
  const include = writtenRelationsInclude(deps, input.modelName, input.nestedOperations, path);
  const read = await readRowsNotInResult({
    client,
    schemaMetadata: deps.schemaMetadata,
    relatedModel,
    path,
    pkFields,
    targets: writeSetAt(walk, path).targets,
    preExisting: input.preExistingRows.get(path),
    parents,
    resolvePath: () => (operation ? resolveToManyPath(deps.schemaMetadata, input.modelName, operation) : undefined),
    include,
  });
  const selection = include ? { include } : {};
  return read.map((rows) => rows.map((row) => ({ row, selection })));
};

const attributePath = async (walk: CollectionWalk, below: readonly RelationBelow[]): Promise<AttributedRow[]> => {
  const held = below.map(({ parent, relation }) => heldRowsOf(parent, relation));
  if (!below[0]?.relation.isList) {
    return below.flatMap(({ relation }, index) =>
      (held[index] ?? []).flatMap((related) => attributeToOneRow(walk, relation, related)),
    );
  }
  const read = await rowsNotInResult(walk, below, held);
  return below.flatMap(({ relation }, index) =>
    attributeToManyRows(walk, relation, [...(held[index] ?? []), ...(read[index] ?? [])]),
  );
};

const walkLevels = async (walk: CollectionWalk, roots: readonly WalkedRow[]): Promise<void> => {
  let level = roots;
  while (level.length > 0) {
    const next: WalkedRow[] = [];
    for (const below of relationsBelow(walk, level).values()) {
      next.push(...(await attributePath(walk, below)));
    }
    level = next;
  }
};

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

const writesTopLevelField = (args: Row, fields: readonly string[]): boolean =>
  [args.data, args.update].some((data) => isRow(data) && fields.some((field) => data[field] !== undefined));

/**
 * The top-level row as the database holds it: the row read before the write, else the row the
 * operation returned when it writes none of `fields`
 */
const topLevelRowAsStored = (input: NestedEventCollectionInput, fields: readonly string[]): Row | undefined => {
  if (input.topLevelBefore.kind === 'captured') {
    return input.topLevelBefore.row;
  }
  return isRow(input.result) && !writesTopLevelField(input.args, fields) ? input.result : undefined;
};

/**
 * The values of `fields` on the top-level row before the write: from the `where` when it names
 * each of them, else from the before state when it was read, else from the result when the
 * operation sets none of them. Undefined when none of those gives them.
 */
const topLevelKeyBeforeWrite = (input: NestedEventCollectionInput, fields: readonly string[]): Row | undefined => {
  const named = keyNamedByWhere(input.args.where, fields);
  if (named) {
    return named;
  }
  const row = topLevelRowAsStored(input, fields);
  return row ? parentKeyOf(row, fields) : undefined;
};

/**
 * The values of `fields` on the parent row of `nestedOp` before the write: for the top-level row,
 * see {@link topLevelKeyBeforeWrite}; for a nested parent, from the primary key its identity
 * encodes when `fields` are among that key's fields. Undefined when neither covers them.
 */
const knownParentKey = (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
  parentModel: string,
  fields: readonly string[],
): Row | undefined => {
  const identity = parentRowIdentityOf(nestedOp.parent, input.nestedPreFetchResults, deps.schemaMetadata);
  if (identity === TOP_LEVEL_ROW) {
    return topLevelKeyBeforeWrite(input, fields);
  }
  const pkFields = getPrimaryKeyConstraint(deps.schemaMetadata, parentModel)?.fields;
  if (identity === undefined || !pkFields || !fields.every((field) => pkFields.includes(field))) {
    return undefined;
  }
  const primaryKey = deserializeEntityId(identity, pkFields);
  return primaryKey ? parentKeyOf(primaryKey, fields) : undefined;
};

/**
 * The foreign-key columns of a row `nestedOp` deletes, when the deleted row holds the foreign key:
 * they equal the parent's referenced columns. Empty when the parent holds it or they are unknown.
 */
const linkColumnsOf = (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
): Row => {
  const link = relationLinkOf(deps.schemaMetadata, input.modelName, nestedOp);
  if (link?.side !== 'related') {
    return {};
  }
  const parentKey = knownParentKey(nestedOp, input, deps, link.parentModel, link.references);
  return parentKey ? attachedFilter(link, parentKey) : {};
};

const LINKING_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set(['connect', 'set', 'connectOrCreate']);

/** Whether a keyword the relation field lists before `nestedOp`, and so runs before it, links `row` to the parent */
const linkedByPrecedingWrite = (nestedOp: NestedOperationInfo, row: Row): boolean =>
  nestedOp.precedingWrites.some(
    ({ operation, data }) =>
      LINKING_KEYWORDS.has(operation) &&
      namedTargets(operation, data).some(({ where }) => matchesUniqueWhere(row, where)),
  );

/**
 * The link columns a row linked to the parent of `nestedOp` holds, from the parent row as the
 * database holds it; empty when the parent holds the foreign key or no read holds that row
 */
const linkColumnsAsStoredOf = (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
): Row => {
  const link = relationLinkOf(deps.schemaMetadata, input.modelName, nestedOp);
  if (link?.side !== 'related') {
    return {};
  }
  const parentRow = nestedOp.parent
    ? parentRowAsStoredOf(nestedOp.parent, input.nestedPreFetchResults, deps.schemaMetadata)
    : topLevelRowAsStored(input, link.references);
  const parentKey = parentRow ? parentKeyOf(parentRow, link.references) : undefined;
  return parentKey ? attachedFilter(link, parentKey) : {};
};

const linksDiffer = (row: Row, linkColumns: Row): boolean =>
  Object.entries(linkColumns).some(([field, value]) => !sameKeyValue(row[field] ?? null, value ?? null));

/**
 * A row read before the write that a keyword listed before the delete linked to the parent, with
 * the row the write deleted: the read row holding the parent's link columns as stored, so it is
 * recorded under the parent it left and the one it was deleted from. Any other row read before
 * the write was deleted as read and carries no row after the write.
 */
const withRowAsWritten = (
  nestedOp: NestedOperationInfo,
  record: CollectedNestedRecord,
  linkColumns: Row,
): CollectedNestedRecord => {
  if (record.beforeState.kind !== 'captured' || !linkedByPrecedingWrite(nestedOp, record.beforeState.row)) {
    return record;
  }
  return linksDiffer(record.beforeState.row, linkColumns)
    ? { ...record, rowAsWritten: { ...record.beforeState.row, ...linkColumns } }
    : record;
};

/**
 * A row whose before state was not read: the key the operation names, completed with the
 * relation's link columns so its parent is known without a read, also as its row after the write
 */
const withLinkColumns = (record: CollectedNestedRecord, linkColumns: Row): CollectedNestedRecord => {
  if (record.beforeState.kind === 'captured') {
    return record;
  }
  const entity = { ...linkColumns, ...record.entity };
  return { ...record, entity, rowAsWritten: entity };
};

/** The rows a nested delete removed (see {@link withRowAsWritten} and {@link withLinkColumns}) */
const collectDeleteRecordsWithLinkColumns = async (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  pkConstraint: UniqueConstraint,
  deps: NestedEventCollectorDependencies,
): Promise<CollectedNestedRecord[]> => {
  const records = await collectDeleteRecords(nestedOp, input, pkConstraint, deps);
  if (records.length === 0) {
    return records;
  }
  const linkColumns = linkColumnsOf(nestedOp, input, deps);
  const linkColumnsAsStored = linkColumnsAsStoredOf(nestedOp, input, deps);
  return records.map((record) => withLinkColumns(withRowAsWritten(nestedOp, record, linkColumnsAsStored), linkColumns));
};

const linkedRowNamedByAt = (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
): LinkedRowNamedBy | undefined => {
  const read = input.linkReads.get(nestedOp.path);
  if (!read || read.failed || !deps.shouldFetchBefore(nestedOp.relatedModel, 'delete')) {
    return undefined;
  }
  return (where) => read.rows.find((row) => matchesUniqueWhere(row, where));
};

const collectDeleteRecords = (
  nestedOp: NestedOperationInfo,
  input: NestedEventCollectionInput,
  pkConstraint: UniqueConstraint,
  deps: NestedEventCollectorDependencies,
): Promise<CollectedNestedRecord[]> =>
  nestedOp.isList
    ? collectToManyDeleteRecords(
        nestedOp,
        input.writeSets.get(nestedOp.path)?.targets ?? [],
        pkConstraint,
        linkedRowNamedByAt(nestedOp, input, deps),
        deps.onUnresolvedDeleteEntityId,
      )
    : collectToOneDeleteRecords(
        nestedOp,
        parentRowIdentityOf(nestedOp.parent, input.nestedPreFetchResults, deps.schemaMetadata),
        input.nestedPreFetchResults,
        pkConstraint,
        deps.onUnresolvedDeleteEntityId,
      );

const auditedIdentitiesAt = (walk: CollectionWalk, path: string): Set<string> => {
  const pkFields = walk.pkConstraints.get(path)?.fields;
  const identities = new Set<string>();
  for (const [nestedOp, records] of walk.records) {
    if (nestedOp.path !== path || !pkFields) {
      continue;
    }
    for (const collected of records) {
      identities.add(identityOf(collected.entity, pkFields, { model: nestedOp.relatedModel, path }));
    }
  }
  return identities;
};

/**
 * Collect the events of the nested records an operation wrote: one per row each executed nested
 * operation is attributed, operation by operation in detection order.
 */
export const collectNestedEvents = async (
  input: NestedEventCollectionInput,
  deps: NestedEventCollectorDependencies,
): Promise<MutationEvent[]> => {
  const { nestedOperations, result } = input;
  const { schemaMetadata } = deps;

  if (nestedOperations.length === 0) {
    return [];
  }

  const pkConstraints = new Map(
    nestedOperations.map((op) => [op.path, getPrimaryKeyConstraint(schemaMetadata, op.relatedModel)]),
  );
  const walk: CollectionWalk = {
    input,
    deps,
    pkConstraints,
    records: new Map(),
    claimed: new Map(),
    assigned: new Set(),
  };
  if (isRow(result)) {
    await walkLevels(walk, [{ row: result, attribution: undefined, selection: input.args }]);
  }

  const linkRecords = await collectLinkChanges({
    client: input.client,
    linkReads: input.linkReads,
    nestedPreFetchResults: input.nestedPreFetchResults,
    auditedOmittedFields: deps.auditedOmittedFields,
    auditedAt: (path) => auditedIdentitiesAt(walk, path),
    fieldNamesOf: (model) => new Set(schemaMetadata.getAllFields(model).map((field) => field.name)),
  });

  const events: MutationEvent[] = [];
  for (const nestedOp of nestedOperations) {
    const pkConstraint = pkConstraints.get(nestedOp.path);
    if (!pkConstraint) {
      nestedLog(
        'model=%s has no primary key; skipping nested records at path=%s',
        nestedOp.relatedModel,
        nestedOp.path,
      );
      continue;
    }
    const records = isDelete(nestedOp)
      ? await collectDeleteRecordsWithLinkColumns(nestedOp, input, pkConstraint, deps)
      : [...(walk.records.get(nestedOp) ?? []), ...(linkRecords.get(nestedOp) ?? [])];
    events.push(...records.map((collected) => toEvent(collected, nestedOp, pkConstraint)));
  }

  return events;
};
