/**
 * Nested mutation event collection
 *
 * Attributes the rows an executed operation returned to the nested operations that wrote them,
 * walking the result from the top-level row down, one level at a time (each written path is
 * handled once for all its parent rows): the rows a relation holds under a returned row
 * are candidates only for the operations nested under the operation that row was attributed to,
 * so a row below a row the operation did not write is not audited, and a row is attributed once
 * however many elements of a list carry a write at its path. Each attributed row's action and
 * before-state are resolved, and one mutation event is yielded per row an operation wrote.
 *
 * A to-many relation is returned whole, so a row there is an operation's only when the write set
 * says so: a row a target locates belongs to that operation (by the primary key of the row read
 * ahead of the operation, or else by its unique WHERE; see `NestedRowLocator`); a row that matches no
 * target and did not exist before the operation was inserted, and belongs to the first operation
 * nested under its parent that inserts rows; any other row is a sibling and yields nothing. The
 * rows the operation wrote at a path that the result does not hold (see `rows-not-in-result.ts`)
 * are read once for the path, with the relations written below them. A `deleteMany` yields one
 * delete event per row its filter matched in that read. A to-one relation holds one related row
 * under its parent row: the row of the operation nested there that names it by unique WHERE, else
 * of the one that writes the related row of its parent.
 */

import type { BeforeState, MutationEvent } from '@kuruwic/db-audit-core';
import {
  getPrimaryKeyConstraint,
  linksNamedRows,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  relationRowsOf,
  targetWhereClauses,
} from '../../grammar/nested-operations.js';
import type { ShouldFetchBefore } from '../../grammar/pre-fetch-selection.js';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { matchesUniqueWhere } from '../../utils/compound-where.js';
import { nestedLog } from '../../utils/debug.js';
import {
  relationNodeOf,
  relationSelectionOf,
  restrictsRows,
  writtenRelationsInclude,
} from '../../utils/nested-write-selection.js';
import type { LinkReads } from '../pre-fetch/link-rows.js';
import { getPreFetchListClient } from '../pre-fetch/model-client.js';
import { parentRowIdentityOf } from '../pre-fetch/parent-rows.js';
import type { PreExistingRows } from '../pre-fetch/pre-existing-rows.js';
import { preFetchedStateNamedBy, preFetchedStateUnder } from '../pre-fetch/pre-fetch-result-store.js';
import { resolveToManyPath } from '../pre-fetch/to-many-path.js';
import type { CollectedNestedRecord } from './collected-record.js';
import {
  collectToManyDeleteRecords,
  collectToOneDeleteRecords,
  type UnresolvedDeleteEntityIdReporter,
} from './delete-handler.js';
import { identityOf } from './event-fields.js';
import { collectLinkChanges } from './link-changes.js';
import { type ParentAtPath, readRowsNotInResult } from './rows-not-in-result.js';
import { resolveNestedRowState } from './state-resolver.js';
import { insertsRows, type NestedWriteSet, type NestedWriteSets, type NestedWriteTarget } from './write-set.js';

type Row = Record<string, unknown>;

export interface NestedEventCollectorDependencies {
  /** Prisma namespace given as the extension's `Prisma` option; read for the DMMF relation details */
  Prisma: PrismaNamespace;
  schemaMetadata: SchemaMetadata;
  shouldFetchBefore: ShouldFetchBefore;
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
 * The operation a returned row was attributed to and the element of its data that wrote it;
 * `element` is undefined for a row a list insert wrote, whose element cannot be told, so every
 * element's nested operations are candidates below it.
 */
interface RowAttribution {
  readonly operation: NestedOperationInfo;
  readonly element: number | undefined;
}

/**
 * A row of the walk: the operation it was attributed to (none for the top-level row), and the
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

/** A row a relation holds, with the selection node it was read with */
interface SourcedRow {
  readonly row: Row;
  readonly selection: Row;
}

/** State shared by the walk over the result */
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
  after: record.entity,
  origin: { path: nestedOp.path, op: nestedOp.operation },
});

const isDelete = (nestedOp: NestedOperationInfo): boolean =>
  nestedOp.operation === 'delete' || nestedOp.operation === 'deleteMany';

/** Whether `nestedOp` was detected in the data that wrote a row attributed `attribution`; the top-level row without one */
const isNestedUnder = (nestedOp: NestedOperationInfo, attribution: RowAttribution | undefined): boolean => {
  if (!attribution) {
    return nestedOp.parent === undefined;
  }
  return (
    nestedOp.parent?.operation === attribution.operation &&
    (attribution.element === undefined || nestedOp.parent.element === attribution.element)
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
 * The rows a to-many relation holds under one parent row that `candidates` wrote: those their
 * targets locate and, for the first candidate that inserts rows, the unclaimed rows that match
 * no target at the path and did not exist before.
 */
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
    const target = targetOf(row, ownTargets);
    if (target) {
      claimed.add(row);
      record(walk, target.operation, row, target.before);
      attributed.push({ row, selection, attribution: { operation: target.operation, element: target.element } });
    }
  }

  const inserting = insertingCandidateOf(candidates, ownTargets);
  if (!inserting) {
    return attributed;
  }
  const preExisting = walk.input.preExistingRows.get(path);
  const origin = { model: inserting.relatedModel, path };
  for (const { row, selection } of rows) {
    if (claimed.has(row) || targetOf(row, writeSet.targets) || preExisting?.has(identityOf(row, pkFields, origin))) {
      continue;
    }
    claimed.add(row);
    record(walk, inserting, row, NO_BEFORE_STATE);
    attributed.push({ row, selection, attribution: { operation: inserting, element: undefined } });
  }
  return attributed;
};

const writeSetAt = (walk: CollectionWalk, path: string): NestedWriteSet =>
  walk.input.writeSets.get(path) ?? { targets: [], createsPending: false };

const ownTargetsOf = (writeSet: NestedWriteSet, candidates: readonly NestedOperationInfo[]): NestedWriteTarget[] =>
  writeSet.targets.filter((target) => candidates.includes(target.operation));

/** The first candidate that inserts rows, given the targets of the candidates */
const insertingCandidateOf = (
  candidates: readonly NestedOperationInfo[],
  targets: readonly NestedWriteTarget[],
): NestedOperationInfo | undefined =>
  candidates.find((candidate) =>
    insertsRows(
      candidate,
      targets.filter((target) => target.operation === candidate),
    ),
  );

const namesRowByWhere = (nestedOp: NestedOperationInfo): boolean =>
  linksNamedRows(nestedOp.operation) || nestedOp.operation === 'connectOrCreate';

/**
 * The candidate a to-one relation's row under one parent row belongs to: the one whose unique
 * WHERE names the row, else one that writes the related row of its parent, preferring one not
 * attributed a row yet (the elements of a list insert cannot be told apart).
 */
const toOneOperationOf = (
  walk: CollectionWalk,
  row: Row,
  candidates: readonly NestedOperationInfo[],
): NestedOperationInfo | undefined => {
  const named = candidates.find(
    (candidate) =>
      namesRowByWhere(candidate) &&
      targetWhereClauses(candidate.operation, candidate.data).some((where) => matchesUniqueWhere(row, where)),
  );
  if (named) {
    return named;
  }
  const writers = candidates.filter((candidate) => !namesRowByWhere(candidate));
  return writers.find((candidate) => !walk.assigned.has(candidate)) ?? writers[0];
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

/** The row a to-one relation holds under one parent row, attributed to the candidate that wrote it */
const attributeToOneRow = (walk: CollectionWalk, relation: CandidateRelation, related: SourcedRow): AttributedRow[] => {
  const { candidates } = relation;
  const nestedOp = toOneOperationOf(walk, related.row, candidates);
  if (!nestedOp) {
    return [];
  }
  walk.assigned.add(nestedOp);
  record(walk, nestedOp, related.row, toOneBeforeState(walk, nestedOp));
  return [{ ...related, attribution: { operation: nestedOp, element: 0 } }];
};

/** A relation written below one attributed row: its path and the operations nested there */
interface CandidateRelation {
  readonly fieldName: string;
  readonly path: string;
  readonly isList: boolean;
  readonly pkFields: readonly string[];
  readonly candidates: NestedOperationInfo[];
}

/** The operations nested under `attribution` that write returned rows, grouped by relation */
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

/** One relation written below a row of the walk, with the operations nested there under that row */
interface RelationBelow {
  readonly parent: WalkedRow;
  readonly relation: CandidateRelation;
}

/** The relations written below `rows`, grouped by path: each path is handled once for all its parent rows */
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

/** The rows a relation holds under a row of the walk, each with the selection node it was read with */
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

/** One parent row at a to-many path as the read of the rows the result does not hold sees it */
const parentAtPath = (walk: CollectionWalk, { parent, relation }: RelationBelow, held: readonly SourcedRow[]) => {
  const ownTargets = ownTargetsOf(writeSetAt(walk, relation.path), relation.candidates);
  const restricted = restrictsRows(relationSelectionOf(parent.selection, relation.fieldName));
  return {
    row: parent.row,
    rows: held.map(({ row }) => row),
    absentTargets: ownTargets.filter(
      (target) => updatesExistingRow(target) && !held.some(({ row }) => isLocatedBy(row, target)),
    ),
    insertsHidden: restricted && insertingCandidateOf(relation.candidates, ownTargets) !== undefined,
  } satisfies ParentAtPath;
};

/**
 * The rows the operation wrote at a to-many path that the result does not hold, per parent row in
 * the order of `below`, read once for the path
 */
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
  const client = getPreFetchListClient(input.client, relatedModel);
  if (!client) {
    throw new Error(
      `[@prisma-audit] Cannot read the nested rows at path "${path}": no model client for "${relatedModel}"`,
    );
  }
  const include = writtenRelationsInclude(deps.schemaMetadata, input.modelName, input.nestedOperations, path);
  const read = await readRowsNotInResult({
    client,
    schemaMetadata: deps.schemaMetadata,
    relatedModel,
    path,
    pkFields,
    targets: writeSetAt(walk, path).targets,
    preExisting: input.preExistingRows.get(path),
    parents,
    resolvePath: () =>
      operation ? resolveToManyPath(deps.Prisma, deps.schemaMetadata, input.modelName, operation) : undefined,
    include,
  });
  const selection = include ? { include } : {};
  return read.map((rows) => rows.map((row) => ({ row, selection })));
};

/** Attributes the rows one written path holds under each of its parent rows */
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

/**
 * Attributes the rows below `roots` one level at a time: the rows attributed at one level are the
 * parent rows of the next.
 */
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
        deps.onUnresolvedDeleteEntityId,
      )
    : collectToOneDeleteRecords(
        nestedOp,
        parentRowIdentityOf(nestedOp.parent, input.nestedPreFetchResults, deps.schemaMetadata),
        input.nestedPreFetchResults,
        pkConstraint,
        deps.onUnresolvedDeleteEntityId,
      );

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

/** The identities of the rows the walk attributed to the operations at `path` */
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
      ? await collectDeleteRecords(nestedOp, input, pkConstraint, deps)
      : [...(walk.records.get(nestedOp) ?? []), ...(linkRecords.get(nestedOp) ?? [])];
    events.push(...records.map((collected) => toEvent(collected, nestedOp, pkConstraint)));
  }

  return events;
};
