/**
 * Batch-operation executor
 *
 * createMany, createManyAndReturn, updateMany, updateManyAndReturn and deleteMany: reads the
 * rows an update or a delete will touch with `findMany`, runs the operation, and collects one
 * event per written row, paired with its before row by primary key.
 */

import type { MutationEvent } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION } from '../grammar/operations.js';
import type { PrismaNamespace } from '../internal-types.js';
import type { SchemaMetadata } from '../schema/types.js';
import {
  buildEntityMap,
  ensureIds,
  extractPrimaryKey,
  findManyByPKs,
  getPrimaryKeyFields,
} from '../utils/id-generation.js';
import { getModelDelegate } from '../utils/model-accessor.js';
import { requiresBeforeState } from '../utils/operation-classifier.js';
import { collectBatchOperationEvents } from './collect-events.js';
import type { ExecutionScope } from './execution-scope.js';
import { type AuditedOperation, createExecutor, type OperationExecutor } from './executor.js';

type Row = Record<string, unknown>;

export interface BatchExecutorDependencies {
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
}

export type BatchPrepared =
  /** createManyAndReturn without select/omit: Prisma generates the ids and returns the rows it created */
  | { readonly kind: 'create-returning' }
  /** createMany, or createManyAndReturn narrowed by select/omit: the rows to insert, with client-generated ids */
  | { readonly kind: 'create'; readonly rows: Row[] }
  /** A `limit`ed update on a connector with updateManyAndReturn: its returned rows are exactly the updated ones */
  | { readonly kind: 'update-returning'; readonly beforeRows: Row[]; readonly pkFields: string[] }
  | { readonly kind: 'update'; readonly beforeRows: Row[]; readonly pkFields: string[] }
  | { readonly kind: 'delete'; readonly beforeRows: Row[] };

export interface BatchExecuted {
  readonly result: unknown;
  /** The rows the mutation itself returned (createManyAndReturn, updateManyAndReturn) */
  readonly returnedRows: Row[] | undefined;
}

interface WrittenRows {
  readonly rows: Row[];
  /** Before state of each row, paired by primary key; absent for a create */
  readonly beforeStates?: Array<Row | null>;
}

interface BatchDelegate {
  readonly findMany: (args: { where: unknown; take?: number }) => Promise<Row[]>;
}

const hasFindMany = (value: unknown): value is BatchDelegate =>
  typeof value === 'object' &&
  value !== null &&
  'findMany' in value &&
  typeof (value as { findMany: unknown }).findMany === 'function';

const hasUpdateManyAndReturn = (value: object): boolean =>
  'updateManyAndReturn' in value && typeof value.updateManyAndReturn === 'function';

const batchDelegate = (scope: ExecutionScope, modelName: string): BatchDelegate => {
  const delegate = getModelDelegate(scope.handle, modelName);
  if (!hasFindMany(delegate)) {
    throw new Error(`Model ${modelName} does not have findMany operation. This is required for batch operations.`);
  }
  return delegate;
};

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

const pairByPrimaryKey = (afterRows: Row[], beforeRows: Row[], pkFields: string[]): WrittenRows => {
  const beforeByPk = buildEntityMap(beforeRows, pkFields);
  return {
    rows: afterRows,
    beforeStates: afterRows.map((row) => beforeByPk.get(extractPrimaryKey(row, pkFields)) ?? null),
  };
};

/**
 * `createMany` returns only `{ count }`, and select/omit narrow returned rows below what
 * aggregate resolvers may need; both leave client-side id injection as the only way for the
 * audit rows to record the created ids. `createManyAndReturn` without select/omit relies on
 * Prisma's own id generation and audits the rows it actually created, which supports
 * database-generated defaults (autoincrement, dbgenerated) and stays correct under
 * skipDuplicates.
 */
const prepareCreate = (operation: AuditedOperation, schemaMetadata: SchemaMetadata): BatchPrepared => {
  const { select, omit, data } = operation.args;
  if (operation.action === AUDIT_ACTION.CREATE_MANY_AND_RETURN && select == null && omit == null) {
    return { kind: 'create-returning' };
  }
  // Single-object data is normalized to an array so `data: {...}` is logged like `data: [...]`
  const rows = Array.isArray(data) ? (data as Row[]) : [data as Row];
  return { kind: 'create', rows: ensureIds(schemaMetadata, operation.model, rows) };
};

/**
 * `updateMany({ limit })` and a separate `findMany({ take })` are not guaranteed to select the
 * same rows, so pre-limiting the before fetch desyncs before/after counts. A connector with
 * `updateManyAndReturn` audits the exact updated rows through it; without it (MySQL), `take`
 * propagates to the before fetch as a best effort.
 */
const prepareUpdateOrDelete = async (
  operation: AuditedOperation,
  scope: ExecutionScope,
  Prisma: PrismaNamespace,
): Promise<BatchPrepared> => {
  const { model, action, args } = operation;
  const delegate = batchDelegate(scope, model);
  const where = args.where ?? {};
  const limit = typeof args.limit === 'number' ? args.limit : undefined;

  if (action !== AUDIT_ACTION.DELETE_MANY && limit !== undefined && hasUpdateManyAndReturn(delegate)) {
    const beforeRows = await delegate.findMany({ where });
    return { kind: 'update-returning', beforeRows, pkFields: getPrimaryKeyFields(Prisma, model) };
  }

  const beforeRows = await delegate.findMany({ where, ...(limit !== undefined ? { take: limit } : {}) });
  if (action === AUDIT_ACTION.DELETE_MANY) {
    return { kind: 'delete', beforeRows };
  }
  return { kind: 'update', beforeRows, pkFields: getPrimaryKeyFields(Prisma, model) };
};

export const createBatchExecutor = (deps: BatchExecutorDependencies): OperationExecutor => {
  const { Prisma, schemaMetadata } = deps;

  const prepare = (operation: AuditedOperation, scope: ExecutionScope): Promise<BatchPrepared> =>
    requiresBeforeState(operation.action)
      ? prepareUpdateOrDelete(operation, scope, Prisma)
      : Promise.resolve(prepareCreate(operation, schemaMetadata));

  const execute = async (
    operation: AuditedOperation,
    _scope: ExecutionScope,
    prepared: BatchPrepared,
  ): Promise<BatchExecuted> => {
    const { action, args } = operation;
    switch (prepared.kind) {
      case 'create':
        return { result: await operation.execute({ ...args, data: prepared.rows }), returnedRows: undefined };
      case 'create-returning': {
        const result = await operation.execute(args);
        return { result, returnedRows: rowsOf(result) };
      }
      case 'update-returning': {
        const rows = rowsOf(await operation.execute(args, AUDIT_ACTION.UPDATE_MANY_AND_RETURN));
        // Each action keeps its contract: updateMany returns { count }, updateManyAndReturn the rows.
        const result = action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN ? rows : { count: rows.length };
        return { result, returnedRows: rows };
      }
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
        return { rows: prepared.rows };
      case 'update-returning':
        return pairByPrimaryKey(executed.returnedRows ?? [], prepared.beforeRows, prepared.pkFields);
      case 'update': {
        if (prepared.beforeRows.length === 0) {
          return { rows: [] };
        }
        // Re-fetched by primary key, not by the original where, so a row whose where-field
        // the update changed still pairs with its before row.
        const delegate = batchDelegate(scope, operation.model);
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
