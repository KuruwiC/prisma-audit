/**
 * Batch-operation executor
 *
 * createMany, createManyAndReturn, updateMany, updateManyAndReturn and deleteMany: reads the
 * rows an update or a delete will touch with `findMany`, runs the operation, and collects one
 * event per written row, paired with its before row by primary key.
 */

import type { FailureSink, MutationEvent } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION } from '../grammar/operations.js';
import type { PrismaNamespace } from '../internal-types.js';
import type { SchemaMetadata } from '../schema/types.js';
import { type AuditedOmittedFields, withOmittedFieldsInFinds } from '../utils/audited-omitted-fields.js';
import {
  buildEntityMap,
  buildPKWhereClause,
  ensureIds,
  extractEntityIdentity,
  findManyByPKs,
  getPrimaryKeyFields,
} from '../utils/id-generation.js';
import { getModelDelegate, hasOperation } from '../utils/model-accessor.js';
import { requiresBeforeState } from '../utils/operation-classifier.js';
import { collectBatchOperationEvents } from './collect-events.js';
import type { ExecutionScope } from './execution-scope.js';
import { type AuditedOperation, createExecutor, type OperationExecutor } from './executor.js';

type Row = Record<string, unknown>;

export interface BatchExecutorDependencies {
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly auditedOmittedFields: AuditedOmittedFields;
  readonly failureSink: FailureSink;
}

export type BatchPrepared =
  /** createManyAndReturn: Prisma generates the ids and returns the rows it created */
  | { readonly kind: 'create-returning' }
  /** createMany: the rows to insert, with client-generated ids */
  | { readonly kind: 'create'; readonly rows: Row[] }
  /** updateManyAndReturn: its returned rows are exactly the updated ones */
  | { readonly kind: 'update-returning'; readonly beforeRows: Row[]; readonly pkFields: string[] }
  | { readonly kind: 'update'; readonly beforeRows: Row[]; readonly pkFields: string[] }
  /** updateMany or deleteMany with a positive integer `limit`: the rows are read round by round as the write runs */
  | { readonly kind: 'limited'; readonly limit: number; readonly pkFields: string[]; readonly rounds: number }
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
  /** Before state of each row, paired by primary key; absent for a create */
  readonly beforeStates?: Array<Row | null>;
}

interface BatchDelegate {
  readonly findMany: (args: { where: unknown; take?: number }) => Promise<Row[]>;
}

/** How many times a limited updateMany or deleteMany reads and writes rows before it settles for its count */
const LIMITED_WRITE_ROUNDS = 3;

const batchDelegate = (
  scope: ExecutionScope,
  modelName: string,
  auditedOmittedFields: AuditedOmittedFields,
): BatchDelegate => {
  const delegate = getModelDelegate(scope.handle, modelName);
  if (!hasOperation<BatchDelegate>(delegate, 'findMany')) {
    throw new Error(`Model ${modelName} does not have findMany operation. This is required for batch operations.`);
  }
  return withOmittedFieldsInFinds(delegate, auditedOmittedFields.of(modelName));
};

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

const pairByPrimaryKey = (afterRows: Row[], beforeRows: Row[], pkFields: string[]): WrittenRows => {
  const beforeByPk = buildEntityMap(beforeRows, pkFields);
  return {
    rows: afterRows,
    beforeStates: afterRows.map((row) => beforeByPk.get(extractEntityIdentity(row, pkFields)) ?? null),
  };
};

/**
 * A `createMany` row as stored, as far as the schema tells without a read: an optional column the
 * data leaves out holds null unless it has a default or is `@updatedAt`, which the database fills,
 * so such a column stays left out.
 */
const storedCreateRows = (schemaMetadata: SchemaMetadata, modelName: string, rows: readonly Row[]): Row[] => {
  const nullWhenUnset = schemaMetadata
    .getAllFields(modelName)
    .filter(
      (field) =>
        (field.kind === 'scalar' || field.kind === 'enum') &&
        !field.isList &&
        !field.isRequired &&
        !field.hasDefaultValue &&
        !field.isUpdatedAt,
    )
    .map((field) => field.name);
  return rows.map((row) => {
    const stored = { ...row };
    for (const fieldName of nullWhenUnset) {
      if (stored[fieldName] === undefined) {
        stored[fieldName] = null;
      }
    }
    return stored;
  });
};

/**
 * `createMany` returns only `{ count }`, which leaves client-side id injection as the only way for
 * the audit rows to record the created ids. `createManyAndReturn` relies on Prisma's own id
 * generation and audits the rows it actually created, read whole whatever the caller selects
 * (see `injectAuditedSelection`), which supports database-generated defaults (autoincrement,
 * dbgenerated) and stays correct under skipDuplicates.
 */
const prepareCreate = (operation: AuditedOperation, schemaMetadata: SchemaMetadata): BatchPrepared => {
  if (operation.action === AUDIT_ACTION.CREATE_MANY_AND_RETURN) {
    return { kind: 'create-returning' };
  }
  const { data } = operation.args;
  // Single-object data is normalized to an array so `data: {...}` is logged like `data: [...]`
  const rows = Array.isArray(data) ? (data as Row[]) : [data as Row];
  return { kind: 'create', rows: ensureIds(schemaMetadata, operation.model, rows) };
};

/**
 * An `updateManyAndReturn` is audited from the rows it returns, so the after rows are not read
 * again. An `updateMany` or `deleteMany` with a `limit` reads its rows as it runs (see
 * `runLimitedWrite`): in rounds inside an interactive transaction, in one narrowed statement
 * outside any. Inside a batch `$transaction([...])` Prisma runs, a read before the write cannot see
 * what the batch's earlier operations wrote, so the operation runs as given.
 */
const prepareUpdateOrDelete = async (
  operation: AuditedOperation,
  scope: ExecutionScope,
  deps: BatchExecutorDependencies,
): Promise<BatchPrepared> => {
  const { Prisma } = deps;
  const { model, action, args } = operation;
  const delegate = batchDelegate(scope, model, deps.auditedOmittedFields);
  const where = args.where ?? {};
  const { limit } = args;

  if ((action === AUDIT_ACTION.UPDATE_MANY || action === AUDIT_ACTION.DELETE_MANY) && limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      return { kind: 'limited-as-given', reportsUnidentified: false };
    }
    if (scope.inPrismaBatch) {
      return { kind: 'limited-as-given', reportsUnidentified: true };
    }
    const rounds = scope.transaction ? LIMITED_WRITE_ROUNDS : 1;
    return { kind: 'limited', limit, pkFields: getPrimaryKeyFields(Prisma, model), rounds };
  }
  if (action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN) {
    const beforeRows = await delegate.findMany({ where });
    return { kind: 'update-returning', beforeRows, pkFields: getPrimaryKeyFields(Prisma, model) };
  }

  const beforeRows = await delegate.findMany({ where });
  if (action === AUDIT_ACTION.DELETE_MANY) {
    return { kind: 'delete', beforeRows };
  }
  return { kind: 'update', beforeRows, pkFields: getPrimaryKeyFields(Prisma, model) };
};

const countOf = (result: unknown): number => {
  const count: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'count') : undefined;
  return typeof count === 'number' ? count : 0;
};

/** One round of a limited write: the rows it read, the `where` it wrote them with, and how many it wrote */
interface LimitedRound {
  readonly rows: Row[];
  readonly narrowed: unknown;
  readonly written: number;
  readonly pkFields: string[];
}

/** Names the rows a round that wrote fewer rows than it read is known to have written */
type WrittenRowsOfShortRound = (delegate: BatchDelegate, round: LimitedRound) => Promise<Row[]>;

/**
 * An update: a read row that still matches the caller's `where` after the update matched it when
 * the update ran, so the update wrote it. A written row the update made stop matching cannot be
 * told apart from a read row another writer changed before the update.
 */
const updatedRowsOfShortRound: WrittenRowsOfShortRound = async (delegate, round) => {
  const readByPk = buildEntityMap(round.rows, round.pkFields);
  const stillMatching = await delegate.findMany({ where: round.narrowed });
  return stillMatching.flatMap((row): Row[] => {
    const readRow = readByPk.get(extractEntityIdentity(row, round.pkFields));
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
    await delegate.findMany({ where: buildPKWhereClause(round.pkFields, round.rows) }),
    round.pkFields,
  );
  const gone = round.rows.filter((row) => !remaining.has(extractEntityIdentity(row, round.pkFields)));
  return gone.length === round.written ? gone : [];
};

const reportUnidentified = async (
  operation: AuditedOperation,
  unidentified: number,
  failureSink: FailureSink,
): Promise<void> => {
  if (unidentified <= 0) {
    return;
  }
  await failureSink.notify({
    phase: 'row-identification',
    modelName: operation.model,
    operation: operation.action,
    params: { unidentified },
    error: new Error(
      `${unidentified} of the rows a limited ${operation.action} wrote cannot be told apart from rows another writer changed`,
    ),
  });
};

/**
 * Runs an `updateMany` or `deleteMany` with a `limit` as the caller's own operation, without the
 * limit and narrowed to the primary keys of the rows a read with the caller's `where` and the limit
 * as `take` selected, so the rows it audits are the rows it wrote. Inside an interactive
 * transaction a round that writes fewer rows than it read (another writer changed some of them in
 * between) is topped up with rows read the same way, leaving out every row already read, at most
 * `LIMITED_WRITE_ROUNDS` rounds in all: the count is a plain operation's, except under contention
 * past the last round. Outside any transaction the operation is one round, one statement, whose
 * count may be lower than a plain operation's under contention. Which rows a short round wrote is
 * read when the records are built (`limitedWrittenRows`).
 */
const runLimitedWrite = async (
  operation: AuditedOperation,
  delegate: BatchDelegate,
  prepared: { readonly limit: number; readonly pkFields: string[]; readonly rounds: number },
): Promise<BatchExecuted> => {
  const { limit, pkFields } = prepared;
  const where = operation.args.where ?? {};
  const unlimited = Object.fromEntries(Object.entries(operation.args).filter(([key]) => key !== 'limit'));
  const read: Row[] = [];
  const limitedRounds: LimitedRound[] = [];
  let count = 0;
  for (let round = 0; round < prepared.rounds && count < limit; round++) {
    const unread = read.length === 0 ? where : { AND: [where, { NOT: buildPKWhereClause(pkFields, read) }] };
    const rows = await delegate.findMany({ where: unread, take: limit - count });
    if (rows.length === 0) {
      break;
    }
    read.push(...rows);
    const narrowed = { AND: [where, buildPKWhereClause(pkFields, rows)] };
    const written = countOf(await operation.execute({ ...unlimited, where: narrowed }));
    count += written;
    limitedRounds.push({ rows, narrowed, written, pkFields });
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
      await reportUnidentified(operation, round.written - named.length, failureSink);
    }
  }
  return known;
};

export const createBatchExecutor = (deps: BatchExecutorDependencies): OperationExecutor => {
  const { schemaMetadata, auditedOmittedFields, failureSink } = deps;

  const prepare = (operation: AuditedOperation, scope: ExecutionScope): Promise<BatchPrepared> =>
    requiresBeforeState(operation.action)
      ? prepareUpdateOrDelete(operation, scope, deps)
      : Promise.resolve(prepareCreate(operation, schemaMetadata));

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
      case 'limited':
        return runLimitedWrite(operation, batchDelegate(scope, operation.model, auditedOmittedFields), prepared);
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
      case 'create':
        return { rows: storedCreateRows(schemaMetadata, operation.model, prepared.rows) };
      case 'update-returning':
        return pairByPrimaryKey(executed.returnedRows ?? [], prepared.beforeRows, prepared.pkFields);
      case 'limited-as-given':
        if (prepared.reportsUnidentified) {
          await reportUnidentified(operation, countOf(executed.result), failureSink);
        }
        return { rows: [] };
      case 'limited': {
        const delegate = batchDelegate(scope, operation.model, auditedOmittedFields);
        const written = await limitedWrittenRows(operation, delegate, executed.limitedRounds ?? [], failureSink);
        if (operation.action === AUDIT_ACTION.DELETE_MANY) {
          // A deleted row cannot be read again: its state is the one read before the delete.
          return { rows: written, beforeStates: written };
        }
        const afterRows = await findManyByPKs(delegate, prepared.pkFields, written);
        return pairByPrimaryKey(afterRows, written, prepared.pkFields);
      }
      case 'update': {
        if (prepared.beforeRows.length === 0) {
          return { rows: [] };
        }
        // Re-fetched by primary key, not by the original where, so a row whose where-field
        // the update changed still pairs with its before row.
        const delegate = batchDelegate(scope, operation.model, auditedOmittedFields);
        const afterRows = await findManyByPKs(delegate, prepared.pkFields, prepared.beforeRows);
        return pairByPrimaryKey(afterRows, prepared.beforeRows, prepared.pkFields);
      }
      case 'delete':
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
    const { rows, beforeStates } = await writtenRows(operation, scope, prepared, executed);
    return collectBatchOperationEvents(
      { modelName: operation.model, action: operation.action, rows, beforeStates },
      schemaMetadata,
    );
  };

  const result = async (executed: BatchExecuted): Promise<unknown> => executed.result;

  return createExecutor({ prepare, execute, collect, result });
};
