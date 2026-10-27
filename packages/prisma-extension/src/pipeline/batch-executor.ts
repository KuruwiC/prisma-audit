/**
 * Batch-operation executor
 *
 * createMany, createManyAndReturn, updateMany, updateManyAndReturn and deleteMany: reads the rows
 * an update or a delete will touch with `findMany`, runs the operation, reads back the rows a
 * createMany wrote by the keys of its data and the rows an updateMany wrote by row key, and
 * collects one event per written row, paired with its before row by row key. A row's key is the
 * model's primary key, or its first unique constraint on required fields when it has no primary key
 * (`rowKeyFieldsOf`). An update's rows are read again and paired by the key the write gives them
 * (`rowKeyWriteOf`): the key they had, with the key fields the data gives literal values replaced.
 * When the data changes the key in a way its arguments do not tell (an operator such as
 * `increment`), the update runs as given and reads no row: the rows of an updateMany are reported
 * as `row-identification` and not audited, and the rows an updateManyAndReturn returns are recorded
 * without a before state and reported. A row another writer re-keys or deletes between the reads
 * does not pair, and is reported the same way, as are the rows an updateMany wrote beyond the
 * rows it read and the rows a deleteMany read beyond the rows it deleted. Every read of the
 * executor reads the row key whatever a client-level omit hides, and the omitted fields the entity
 * records (`withRowKeyFields`).
 */

import type { FailureSink, MutationEvent } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION } from '../grammar/operations.js';
import type { PrismaNamespace } from '../internal-types.js';
import type { SchemaMetadata } from '../schema/types.js';
import { type AuditedOmittedFields, withOmittedFieldsInFinds } from '../utils/audited-omitted-fields.js';
import { UNAVAILABLE_BEFORE_STATE } from '../utils/before-state.js';
import {
  buildEntityMap,
  buildKeyWhereClause,
  ensureIds,
  extractEntityIdentity,
  findManyByKeys,
  getRowKeyFields,
} from '../utils/id-generation.js';
import type { EntityIdentityKey } from '../utils/identity-key.js';
import { getModelDelegate, hasOperation } from '../utils/model-accessor.js';
import { requiresBeforeState } from '../utils/operation-classifier.js';
import { type DerivableRowKeyWrite, NO_ROW_KEY_WRITE, rowKeyWriteOf, withWrittenKey } from '../utils/row-key-write.js';
import { collectBatchOperationEvents } from './collect-events.js';
import type { ExecutionScope } from './execution-scope.js';
import { type AuditedOperation, createExecutor, type OperationExecutor } from './executor.js';

type Row = Record<string, unknown>;

export interface BatchExecutorDependencies {
  /**
   * Prisma namespace given as the extension's `Prisma` option; its `skip` leaves a data field
   * unwritten, and its `Decimal` is the type a `Decimal` key is read back in
   */
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly auditedOmittedFieldsWithRowKey: AuditedOmittedFields;
  readonly failureSink: FailureSink;
}

export type BatchPrepared =
  /** createManyAndReturn: Prisma generates the ids and returns the rows it created */
  | { readonly kind: 'create-returning' }
  /** createMany: the rows to insert, with client-generated key values, and the fields of that key */
  | { readonly kind: 'create'; readonly rows: Row[]; readonly keyFields: string[] }
  /** updateManyAndReturn: its returned rows are exactly the updated ones */
  | {
      readonly kind: 'update-returning';
      readonly beforeRows: Row[];
      readonly keyFields: string[];
      readonly keyWrite: DerivableRowKeyWrite;
    }
  | {
      readonly kind: 'update';
      readonly beforeRows: Row[];
      readonly keyFields: string[];
      readonly keyWrite: DerivableRowKeyWrite;
    }
  /**
   * updateMany (with or without a `limit`) or updateManyAndReturn whose data changes the key in a
   * way its arguments do not tell: run as given, no row read
   */
  | { readonly kind: 'key-not-followed' }
  /** updateMany or deleteMany with a positive integer `limit`: the rows are read round by round as the write runs */
  | {
      readonly kind: 'limited';
      readonly limit: number;
      readonly keyFields: string[];
      readonly rounds: number;
      readonly keyWrite: DerivableRowKeyWrite;
    }
  /**
   * updateMany or deleteMany with a `limit`, run as given: inside a batch `$transaction([...])`
   * Prisma runs (`reportsUnidentified`), or with a limit Prisma rejects
   */
  | { readonly kind: 'limited-as-given'; readonly reportsUnidentified: boolean }
  | { readonly kind: 'delete'; readonly beforeRows: Row[] };

export interface BatchExecuted {
  readonly result: unknown;
  /** The rows the mutation itself returned (createManyAndReturn, updateManyAndReturn) */
  readonly returnedRows: Row[] | undefined;
  /** The rounds a limited updateMany or deleteMany ran */
  readonly limitedRounds?: readonly LimitedRound[];
}

interface WrittenRows {
  readonly rows: Row[];
  /** Before state of each row, paired by row key; absent for a create */
  readonly beforeStates?: Array<Row | null>;
  /** Indexes of the rows to record with an unavailable before state, a row's own pairing having failed */
  readonly unavailableBefore?: ReadonlySet<number>;
}

interface BatchDelegate {
  readonly findMany: (args: { where: unknown; take?: number }) => Promise<Row[]>;
}

/** How many times a limited updateMany or deleteMany reads and writes rows before it settles for its count */
const LIMITED_WRITE_ROUNDS = 3;

/** The model's delegate on the scope's handle, its finds reading the fields of `readFields` although the client omits them */
const batchDelegate = (scope: ExecutionScope, modelName: string, readFields: AuditedOmittedFields): BatchDelegate => {
  const delegate = getModelDelegate(scope.handle, modelName);
  if (!hasOperation<BatchDelegate>(delegate, 'findMany')) {
    throw new Error(`Model ${modelName} does not have findMany operation. This is required for batch operations.`);
  }
  return withOmittedFieldsInFinds(delegate, readFields.of(modelName));
};

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/** `rows` by the key the write gives each of them */
const byWrittenKey = (rows: readonly Row[], keyFields: string[], keyWrite: DerivableRowKeyWrite) =>
  new Map(rows.map((row) => [extractEntityIdentity(withWrittenKey(row, keyWrite), keyFields), row]));

/** `rows` as the write leaves them: each with the key the write gives it */
const underWrittenKeys = (rows: readonly Row[], keyWrite: DerivableRowKeyWrite): Row[] =>
  rows.map((row) => withWrittenKey(row, keyWrite));

/** Pairs each of `afterRows` with the row of `beforeRows` the write gave its key */
const pairByRowKey = (
  afterRows: Row[],
  beforeRows: Row[],
  keyFields: string[],
  keyWrite: DerivableRowKeyWrite,
): WrittenRows => {
  const beforeByKey = byWrittenKey(beforeRows, keyFields, keyWrite);
  return {
    rows: afterRows,
    beforeStates: afterRows.map((row) => beforeByKey.get(extractEntityIdentity(row, keyFields)) ?? null),
  };
};

/**
 * `createMany` returns only `{ count }`, which leaves `data` as the only way to know the keys of the
 * rows it inserts: the model's row key (`getRowKeyFields`). `ensureIds` fills in client-side the key
 * fields `data` leaves out, and the rows it audits are the ones read back by those keys after the
 * write (`createdRows`).
 * `createManyAndReturn` relies on Prisma's own id generation and audits the rows it actually
 * created, read whole whatever the caller selects (see `injectAuditedSelection`), which supports
 * database-generated defaults (autoincrement, dbgenerated) and stays correct under skipDuplicates.
 */
const prepareCreate = (operation: AuditedOperation, deps: BatchExecutorDependencies): BatchPrepared => {
  if (operation.action === AUDIT_ACTION.CREATE_MANY_AND_RETURN) {
    return { kind: 'create-returning' };
  }
  const { data } = operation.args;
  // Single-object data is normalized to an array so `data: {...}` is logged like `data: [...]`
  const rows = Array.isArray(data) ? (data as Row[]) : [data as Row];
  const keyFields = getRowKeyFields(deps.schemaMetadata, operation.model);
  return { kind: 'create', rows: ensureIds(deps.schemaMetadata, operation.model, rows, keyFields), keyFields };
};

/**
 * The rows a `createMany` inserted, as the client reads them by the keys of `data`: every row the
 * read returns, once per key as read. The database compares the keys, so a row whose key it stores
 * or returns otherwise than `data` gave it (a case-insensitive collation, a BigInt given as a
 * number, a truncated DateTime) is found all the same; `data` only orders the rows, those whose key
 * reads as `data` gave it first, in `data` order, then the others in read order. A row of `data`
 * the read does not find was not created (skipped under `skipDuplicates`) or is not visible to the
 * read. A row skipped because a row with its key already exists reads as that row.
 */
const createdRows = async (delegate: BatchDelegate, rows: readonly Row[], keyFields: string[]): Promise<Row[]> => {
  const read = buildEntityMap(await findManyByKeys(delegate, keyFields, rows), keyFields);
  const position = new Map<EntityIdentityKey, number>();
  rows.forEach((row, index) => {
    const identity = extractEntityIdentity(row, keyFields);
    if (!position.has(identity)) {
      position.set(identity, index);
    }
  });
  const ranked = Array.from(read, ([identity, row]) => ({ row, rank: position.get(identity) ?? rows.length }));
  return ranked.sort((a, b) => a.rank - b.rank).map(({ row }) => row);
};

/** An `updateMany` or `deleteMany` with a `limit`: run as given, or in rounds narrowed to the keys each reads */
const prepareLimited = (
  limit: unknown,
  scope: ExecutionScope,
  keyWrite: DerivableRowKeyWrite,
  rowKeyFields: () => string[],
): BatchPrepared => {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return { kind: 'limited-as-given', reportsUnidentified: false };
  }
  if (scope.prismaBatch) {
    return { kind: 'limited-as-given', reportsUnidentified: true };
  }
  const rounds = scope.transaction ? LIMITED_WRITE_ROUNDS : 1;
  return { kind: 'limited', limit, keyFields: rowKeyFields(), rounds, keyWrite };
};

/**
 * An `updateManyAndReturn` is audited from the rows it returns, so the after rows are not read
 * again. An `updateMany` or `deleteMany` with a `limit` reads its rows as it runs (see
 * `runLimitedWrite`): in rounds inside an interactive transaction, in one narrowed statement
 * outside any. Inside a batch `$transaction([...])` Prisma runs, a read before the write cannot see
 * what the batch's earlier operations wrote, so the operation runs as given. An update whose data
 * changes the key in a way its arguments do not tell runs as given too: no row it writes could be
 * found or paired by key, so none is read.
 */
const prepareUpdateOrDelete = async (
  operation: AuditedOperation,
  scope: ExecutionScope,
  deps: BatchExecutorDependencies,
): Promise<BatchPrepared> => {
  const { model, action, args } = operation;
  const rowKeyFields = () => getRowKeyFields(deps.schemaMetadata, model);
  const delegate = batchDelegate(scope, model, deps.auditedOmittedFieldsWithRowKey);
  const where = args.where ?? {};
  const { limit } = args;
  const keyWrite =
    action === AUDIT_ACTION.DELETE_MANY
      ? NO_ROW_KEY_WRITE
      : rowKeyWriteOf(deps.schemaMetadata, model, args.data, deps.Prisma);

  if (keyWrite.kind === 'not-derivable') {
    return { kind: 'key-not-followed' };
  }
  if ((action === AUDIT_ACTION.UPDATE_MANY || action === AUDIT_ACTION.DELETE_MANY) && limit !== undefined) {
    return prepareLimited(limit, scope, keyWrite, rowKeyFields);
  }
  if (action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN) {
    const keyFields = rowKeyFields();
    return { kind: 'update-returning', beforeRows: await delegate.findMany({ where }), keyFields, keyWrite };
  }
  if (action === AUDIT_ACTION.DELETE_MANY) {
    return { kind: 'delete', beforeRows: await delegate.findMany({ where }) };
  }
  const keyFields = rowKeyFields();
  return { kind: 'update', beforeRows: await delegate.findMany({ where }), keyFields, keyWrite };
};

const countOf = (result: unknown): number => {
  const count: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'count') : undefined;
  return typeof count === 'number' ? count : 0;
};

/**
 * One round of a limited write: the rows it read, the `where` it wrote them with, how many it
 * wrote, and the `where` that finds, after the write, the rows it wrote that still match the
 * caller's `where` (by the key the write gave them)
 */
interface LimitedRound {
  readonly rows: Row[];
  readonly narrowed: unknown;
  readonly written: number;
  readonly keyFields: string[];
  readonly keyWrite: DerivableRowKeyWrite;
  readonly matchingAfter: unknown;
}

/** Names the rows a round that wrote fewer rows than it read is known to have written */
type WrittenRowsOfShortRound = (delegate: BatchDelegate, round: LimitedRound) => Promise<Row[]>;

/**
 * An update: a read row that still matches the caller's `where` after the update matched it when
 * the update ran, so the update wrote it. A written row the update made stop matching cannot be
 * told apart from a read row another writer changed before the update.
 */
const updatedRowsOfShortRound: WrittenRowsOfShortRound = async (delegate, round) => {
  const readByKey = byWrittenKey(round.rows, round.keyFields, round.keyWrite);
  const stillMatching = await delegate.findMany({ where: round.matchingAfter });
  return stillMatching.flatMap((row): Row[] => {
    const readRow = readByKey.get(extractEntityIdentity(row, round.keyFields));
    return readRow ? [readRow] : [];
  });
};

/**
 * A delete: a read row that still exists was not deleted. When exactly as many read rows are gone
 * as the delete deleted, those are the deleted rows; when more are gone, another writer deleted
 * some of them, and none can be told apart.
 */
const deletedRowsOfShortRound: WrittenRowsOfShortRound = async (delegate, round) => {
  const remaining = buildEntityMap(
    await delegate.findMany({ where: buildKeyWhereClause(round.keyFields, round.rows) }),
    round.keyFields,
  );
  const gone = round.rows.filter((row) => !remaining.has(extractEntityIdentity(row, round.keyFields)));
  return gone.length === round.written ? gone : [];
};

/** Why `unidentified` rows the operation wrote are not audited */
type UnidentifiedReason = (operation: AuditedOperation, unidentified: number) => string;

const limitedRowsOfOtherWriters: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows a limited ${operation.action} wrote cannot be told apart from rows another writer changed`;

const createdRowsNotReadBack: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows a ${operation.action} created ${unidentified === 1 ? 'was' : 'were'} not found when read back by key`;

const rowsNotFoundAfterWrite: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows read before an ${operation.action} are not found by key after it, so they are not audited: another writer changed their key or deleted them`;

const returnedRowsWithoutBefore: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows an ${operation.action} returned pair with no row read before the write by key, so they have no before state`;

const writtenRowsKeyNotFollowed: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows an ${operation.action} wrote are not audited: its data changes their key in a way the audit cannot follow`;

const returnedRowsKeyNotFollowed: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows an ${operation.action} returned are recorded without a before state: its data changes their key in a way the audit cannot follow`;

const writtenRowsNotRead: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows an ${operation.action} wrote ${unidentified === 1 ? 'was' : 'were'} not read before it, so they are not audited: another writer made them match its where after the read`;

const readRowsNotDeleted: UnidentifiedReason = (operation, unidentified) =>
  `${unidentified} of the rows read before a ${operation.action} ${unidentified === 1 ? 'was' : 'were'} not deleted by it, yet every row read is audited as deleted: another writer deleted them or moved them out of its where after the read, and which ones cannot be told`;

const reportUnidentified = async (
  operation: AuditedOperation,
  unidentified: number,
  failureSink: FailureSink,
  reason: UnidentifiedReason,
): Promise<void> => {
  if (unidentified <= 0) {
    return;
  }
  await failureSink.notify({
    phase: 'row-identification',
    modelName: operation.model,
    operation: operation.action,
    params: { unidentified },
    error: new Error(reason(operation, unidentified)),
  });
};

/**
 * Pairs the rows an update re-read after the write with the `readRows` it read before, by the key
 * the write gave each of them. The re-read is by those keys, so a row another writer re-keyed or
 * deleted in between
 * is missing from it: such a row is not audited, and the number of them is reported as
 * `row-identification`.
 */
const pairReReadRows = async (
  operation: AuditedOperation,
  afterRows: Row[],
  readRows: Row[],
  keyFields: string[],
  keyWrite: DerivableRowKeyWrite,
  failureSink: FailureSink,
): Promise<WrittenRows> => {
  await reportUnidentified(operation, readRows.length - afterRows.length, failureSink, rowsNotFoundAfterWrite);
  return pairByRowKey(afterRows, readRows, keyFields, keyWrite);
};

/**
 * Pairs the rows an `updateManyAndReturn` returned with the rows read before it, by the key the
 * write gave each of them. The
 * update wrote every returned row, so one with no before row (another writer inserted it or changed
 * its key between the read and the write) is still recorded, with an unavailable before state, and
 * its number is reported as `row-identification`.
 */
const pairReturnedRows = async (
  operation: AuditedOperation,
  returnedRows: Row[],
  beforeRows: Row[],
  keyFields: string[],
  keyWrite: DerivableRowKeyWrite,
  failureSink: FailureSink,
): Promise<WrittenRows> => {
  const paired = pairByRowKey(returnedRows, beforeRows, keyFields, keyWrite);
  const unavailableBefore = new Set<number>();
  paired.beforeStates?.forEach((before, index) => {
    if (before === null) {
      unavailableBefore.add(index);
    }
  });
  await reportUnidentified(operation, unavailableBefore.size, failureSink, returnedRowsWithoutBefore);
  return { ...paired, unavailableBefore };
};

/**
 * The rows of an update whose data changes the key in a way its arguments do not tell, which ran
 * as given: the rows an `updateManyAndReturn` returned are recorded with an unavailable before
 * state; an `updateMany`'s rows are not audited. Their number is reported as `row-identification`.
 */
const keyNotFollowedRows = async (
  operation: AuditedOperation,
  executed: BatchExecuted,
  failureSink: FailureSink,
): Promise<WrittenRows> => {
  const returnedRows = executed.returnedRows;
  if (!returnedRows) {
    await reportUnidentified(operation, countOf(executed.result), failureSink, writtenRowsKeyNotFollowed);
    return { rows: [] };
  }
  await reportUnidentified(operation, returnedRows.length, failureSink, returnedRowsKeyNotFollowed);
  return {
    rows: returnedRows,
    beforeStates: returnedRows.map(() => null),
    unavailableBefore: new Set(returnedRows.keys()),
  };
};

/** The rows of `rows` whose key the write changes, each under the key the write gives it */
const rowsUnderNewKeys = (rows: readonly Row[], keyFields: string[], keyWrite: DerivableRowKeyWrite): Row[] =>
  rows
    .map((row) => withWrittenKey(row, keyWrite))
    .filter((rekeyed, index) => {
      const row = rows[index];
      return row !== undefined && extractEntityIdentity(rekeyed, keyFields) !== extractEntityIdentity(row, keyFields);
    });

/**
 * Runs an `updateMany` or `deleteMany` with a `limit` as the caller's own operation, without the
 * limit and narrowed to the row keys of the rows a read with the caller's `where` and the limit
 * as `take` selected, so the rows it audits are the rows it wrote. Inside an interactive
 * transaction a round that writes fewer rows than it read (another writer changed some of them in
 * between) is topped up with rows read the same way, leaving out every row already read, under
 * the key it was read with and the key the write gives it, at most `LIMITED_WRITE_ROUNDS` rounds in
 * all: the count is a plain operation's, except under contention past the last round. Outside any
 * transaction the operation is one round, one statement, whose count may be lower than a plain
 * operation's under contention. Which rows a short round wrote is read when the records are built
 * (`limitedWrittenRows`).
 */
const runLimitedWrite = async (
  operation: AuditedOperation,
  delegate: BatchDelegate,
  prepared: {
    readonly limit: number;
    readonly keyFields: string[];
    readonly rounds: number;
    readonly keyWrite: DerivableRowKeyWrite;
  },
): Promise<BatchExecuted> => {
  const { limit, keyFields, keyWrite } = prepared;
  const where = operation.args.where ?? {};
  const unlimited = Object.fromEntries(Object.entries(operation.args).filter(([key]) => key !== 'limit'));
  const read: Row[] = [];
  const limitedRounds: LimitedRound[] = [];
  let count = 0;
  for (let round = 0; round < prepared.rounds && count < limit; round++) {
    const unread = read.length === 0 ? where : { AND: [where, { NOT: buildKeyWhereClause(keyFields, read) }] };
    const rows = await delegate.findMany({ where: unread, take: limit - count });
    if (rows.length === 0) {
      break;
    }
    const rekeyed = rowsUnderNewKeys(rows, keyFields, keyWrite);
    read.push(...rows, ...rekeyed);
    const narrowed = { AND: [where, buildKeyWhereClause(keyFields, rows)] };
    const written = countOf(await operation.execute({ ...unlimited, where: narrowed }));
    count += written;
    const matchingAfter =
      rekeyed.length === 0
        ? narrowed
        : { AND: [where, buildKeyWhereClause(keyFields, underWrittenKeys(rows, keyWrite))] };
    limitedRounds.push({ rows, narrowed, written, keyFields, keyWrite, matchingAfter });
    if (written === rows.length) {
      break;
    }
  }
  return { result: { count }, returnedRows: undefined, limitedRounds };
};

/**
 * The before state of each row the rounds are known to have written: every row of a round that
 * wrote as many rows as it read, and in a short round the rows `writtenRowsOfShortRound` names;
 * the number of written rows it cannot name is reported as `row-identification`, and they are not
 * audited.
 */
const limitedWrittenRows = async (
  operation: AuditedOperation,
  delegate: BatchDelegate,
  rounds: readonly LimitedRound[],
  failureSink: FailureSink,
): Promise<Row[]> => {
  const writtenRowsOfShortRound =
    operation.action === AUDIT_ACTION.DELETE_MANY ? deletedRowsOfShortRound : updatedRowsOfShortRound;
  const known: Row[] = [];
  for (const round of rounds) {
    if (round.written === round.rows.length) {
      known.push(...round.rows);
    } else if (round.written > 0) {
      const named = await writtenRowsOfShortRound(delegate, round);
      known.push(...named);
      await reportUnidentified(operation, round.written - named.length, failureSink, limitedRowsOfOtherWriters);
    }
  }
  return known;
};

/**
 * The rows of a limited write with their before states. A delete's rows keep the state read before
 * it; an update's rows are read again by the key the write gave them and paired with it.
 */
const limitedWriteRows = async (
  operation: AuditedOperation,
  delegate: BatchDelegate,
  prepared: { readonly keyFields: string[]; readonly keyWrite: DerivableRowKeyWrite },
  executed: BatchExecuted,
  failureSink: FailureSink,
): Promise<WrittenRows> => {
  const written = await limitedWrittenRows(operation, delegate, executed.limitedRounds ?? [], failureSink);
  if (operation.action === AUDIT_ACTION.DELETE_MANY) {
    // A deleted row cannot be read again: its state is the one read before the delete.
    return { rows: written, beforeStates: written };
  }
  const { keyFields, keyWrite } = prepared;
  const afterRows = await findManyByKeys(delegate, keyFields, underWrittenKeys(written, keyWrite));
  return pairReReadRows(operation, afterRows, written, keyFields, keyWrite, failureSink);
};

/**
 * Counts see only a surplus: when another writer also moves a read row out of the `where`, the
 * count can match while that row is audited as updated and the row moved in is not, unreported.
 */
const reportRowsWrittenBeyondRead = (
  operation: AuditedOperation,
  readRows: readonly Row[],
  executed: BatchExecuted,
  failureSink: FailureSink,
): Promise<void> =>
  reportUnidentified(operation, countOf(executed.result) - readRows.length, failureSink, writtenRowsNotRead);

/** Prisma does not return the rows a `deleteMany` deleted, so every row read stays audited as deleted */
const reportRowsReadBeyondDeleted = (
  operation: AuditedOperation,
  readRows: readonly Row[],
  executed: BatchExecuted,
  failureSink: FailureSink,
): Promise<void> =>
  reportUnidentified(operation, readRows.length - countOf(executed.result), failureSink, readRowsNotDeleted);

export const createBatchExecutor = (deps: BatchExecutorDependencies): OperationExecutor => {
  const { schemaMetadata, auditedOmittedFieldsWithRowKey, failureSink } = deps;

  const delegateOf = (scope: ExecutionScope, modelName: string): BatchDelegate =>
    batchDelegate(scope, modelName, auditedOmittedFieldsWithRowKey);

  const prepare = (operation: AuditedOperation, scope: ExecutionScope): Promise<BatchPrepared> =>
    requiresBeforeState(operation.action)
      ? prepareUpdateOrDelete(operation, scope, deps)
      : Promise.resolve(prepareCreate(operation, deps));

  const execute = async (
    operation: AuditedOperation,
    scope: ExecutionScope,
    prepared: BatchPrepared,
  ): Promise<BatchExecuted> => {
    const { args } = operation;
    switch (prepared.kind) {
      case 'create':
        return { result: await operation.execute({ ...args, data: prepared.rows }), returnedRows: undefined };
      case 'create-returning': {
        const result = await operation.execute(args);
        return { result, returnedRows: rowsOf(result) };
      }
      case 'update-returning': {
        const result = await operation.execute(args);
        return { result, returnedRows: rowsOf(result) };
      }
      case 'key-not-followed': {
        const result = await operation.execute(args);
        const returns = operation.action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN;
        return { result, returnedRows: returns ? rowsOf(result) : undefined };
      }
      case 'limited':
        return runLimitedWrite(operation, delegateOf(scope, operation.model), prepared);
      case 'limited-as-given':
      case 'update':
      case 'delete':
        return { result: await operation.execute(args), returnedRows: undefined };
      default: {
        const exhaustiveCheck: never = prepared;
        throw new Error(`[@prisma-audit] Unhandled batch preparation: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };

  const writtenRows = async (
    operation: AuditedOperation,
    scope: ExecutionScope,
    prepared: BatchPrepared,
    executed: BatchExecuted,
  ): Promise<WrittenRows> => {
    switch (prepared.kind) {
      case 'create-returning':
        return { rows: executed.returnedRows ?? [] };
      case 'create': {
        const delegate = delegateOf(scope, operation.model);
        const rows = await createdRows(delegate, prepared.rows, prepared.keyFields);
        await reportUnidentified(
          operation,
          countOf(executed.result) - rows.length,
          failureSink,
          createdRowsNotReadBack,
        );
        return { rows };
      }
      case 'update-returning':
        return pairReturnedRows(
          operation,
          executed.returnedRows ?? [],
          prepared.beforeRows,
          prepared.keyFields,
          prepared.keyWrite,
          failureSink,
        );
      case 'limited-as-given':
        if (prepared.reportsUnidentified) {
          await reportUnidentified(operation, countOf(executed.result), failureSink, limitedRowsOfOtherWriters);
        }
        return { rows: [] };
      case 'key-not-followed':
        return keyNotFollowedRows(operation, executed, failureSink);
      case 'limited':
        return limitedWriteRows(operation, delegateOf(scope, operation.model), prepared, executed, failureSink);
      case 'update': {
        await reportRowsWrittenBeyondRead(operation, prepared.beforeRows, executed, failureSink);
        if (prepared.beforeRows.length === 0) {
          return { rows: [] };
        }
        // Re-fetched by the key the write gave each row, not by the original where, so a row whose
        // where-field the update changed still pairs with its before row.
        const { beforeRows, keyFields, keyWrite } = prepared;
        const delegate = delegateOf(scope, operation.model);
        const afterRows = await findManyByKeys(delegate, keyFields, underWrittenKeys(beforeRows, keyWrite));
        return pairReReadRows(operation, afterRows, beforeRows, keyFields, keyWrite, failureSink);
      }
      case 'delete':
        await reportRowsReadBeyondDeleted(operation, prepared.beforeRows, executed, failureSink);
        return { rows: prepared.beforeRows, beforeStates: prepared.beforeRows };
      default: {
        const exhaustiveCheck: never = prepared;
        throw new Error(`[@prisma-audit] Unhandled batch preparation: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };

  const collect = async (
    operation: AuditedOperation,
    scope: ExecutionScope,
    prepared: BatchPrepared,
    executed: BatchExecuted,
  ): Promise<MutationEvent[]> => {
    const { rows, beforeStates, unavailableBefore } = await writtenRows(operation, scope, prepared, executed);
    const events = collectBatchOperationEvents(
      { modelName: operation.model, action: operation.action, rows, beforeStates },
      schemaMetadata,
    );
    return unavailableBefore
      ? events.map((event, index) =>
          unavailableBefore.has(index) ? { ...event, before: UNAVAILABLE_BEFORE_STATE } : event,
        )
      : events;
  };

  const result = async (executed: BatchExecuted): Promise<unknown> => executed.result;

  return createExecutor({ prepare, execute, collect, result });
};
