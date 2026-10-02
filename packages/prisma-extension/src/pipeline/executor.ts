/**
 * Operation executors
 *
 * A single operation (create, update, upsert, delete) and a batch operation (createMany,
 * updateMany, deleteMany and their returning variants) read, mutate and collect differently.
 * An executor is those steps behind one `run`, which performs the reads before the write and the
 * write, and hands back the caller's result with the build of the audit records: collecting the
 * events the write left behind and handing them to the record producer, run once the write has run.
 */

import type { AuditRecord, MutationEvent } from '@kuruwic/db-audit-core';
import type { AuditAction } from '../grammar/operations.js';
import type { ExecutionScope } from './execution-scope.js';
import type { RecordProducer } from './produce-records.js';

export interface AuditedOperation {
  readonly model: string;
  readonly action: AuditAction;
  readonly args: Record<string, unknown>;
  /**
   * Runs the caller's mutation with `args` on the client the execution scope selected (see
   * `operationContinuation` in run-audited-operation.ts). `action` substitutes another action
   * of the same model for the intercepted one.
   */
  readonly execute: (args: Record<string, unknown>, action?: AuditAction) => Promise<unknown>;
}

export interface OperationSteps<TPrepared, TExecuted> {
  /** Every read that has to happen before the write: before states, nested pre-fetches, id injection */
  readonly prepare: (operation: AuditedOperation, scope: ExecutionScope) => Promise<TPrepared>;
  /** The caller's own mutation, run through `operation.execute` so its failure propagates untouched */
  readonly execute: (operation: AuditedOperation, scope: ExecutionScope, prepared: TPrepared) => Promise<TExecuted>;
  readonly collect: (
    operation: AuditedOperation,
    scope: ExecutionScope,
    prepared: TPrepared,
    executed: TExecuted,
  ) => Promise<MutationEvent[]>;
  /** The value the caller receives */
  readonly result: (executed: TExecuted) => Promise<unknown>;
}

export interface ExecutedOperation {
  /** The value the caller receives */
  readonly result: unknown;
  /** Reads what the write left behind and builds the audit records from it */
  readonly buildRecords: () => Promise<AuditRecord[]>;
}

export interface OperationExecutor {
  readonly run: (
    operation: AuditedOperation,
    scope: ExecutionScope,
    produceRecords: RecordProducer,
  ) => Promise<ExecutedOperation>;
}

export const createExecutor = <TPrepared, TExecuted>(
  steps: OperationSteps<TPrepared, TExecuted>,
): OperationExecutor => ({
  run: async (operation, scope, produceRecords) => {
    const prepared = await steps.prepare(operation, scope);
    const executed = await steps.execute(operation, scope, prepared);
    const result = await steps.result(executed);
    const buildRecords = async (): Promise<AuditRecord[]> =>
      produceRecords(await steps.collect(operation, scope, prepared, executed), scope);
    return { result, buildRecords };
  },
});
