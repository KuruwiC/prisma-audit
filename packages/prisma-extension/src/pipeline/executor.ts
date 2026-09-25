/**
 * Operation executors
 *
 * A single operation (create, update, upsert, delete) and a batch operation (createMany,
 * updateMany, deleteMany and their returning variants) read, mutate and collect differently.
 * An executor is those steps behind one `run`, which performs them in order and hands the
 * collected events to the record producer.
 */

import type { AuditAction, MutationEvent } from '@kuruwic/prisma-audit-core';
import type { AuditLogData } from '../types.js';
import type { ExecutionScope } from './execution-scope.js';
import type { RecordProducer } from './produce-records.js';

/** A write operation `$allOperations` intercepted, on a known model */
export interface AuditedOperation {
  readonly model: string;
  readonly action: AuditAction;
  readonly args: Record<string, unknown>;
  /**
   * Runs the caller's mutation with `args` on the client the execution scope selected, through
   * `runCallerMutation` (see `operationContinuation` in run-audited-operation.ts). `action`
   * substitutes another action of the same model for the intercepted one.
   */
  readonly execute: (args: Record<string, unknown>, action?: AuditAction) => Promise<unknown>;
}

export interface OperationSteps<TPrepared, TExecuted> {
  /** Every read that has to happen before the write: before states, nested pre-fetches, id injection */
  readonly prepare: (operation: AuditedOperation, scope: ExecutionScope) => Promise<TPrepared>;
  /** The caller's own mutation, run through `operation.execute` so its failure propagates untouched */
  readonly execute: (operation: AuditedOperation, scope: ExecutionScope, prepared: TPrepared) => Promise<TExecuted>;
  /** One mutation event per row the operation wrote */
  readonly collect: (
    operation: AuditedOperation,
    scope: ExecutionScope,
    prepared: TPrepared,
    executed: TExecuted,
  ) => Promise<MutationEvent[]>;
  /** The value the caller receives */
  readonly result: (operation: AuditedOperation, scope: ExecutionScope, executed: TExecuted) => Promise<unknown>;
}

export interface OperationOutcome {
  readonly result: unknown;
  readonly records: AuditLogData[];
}

export interface OperationExecutor {
  readonly run: (
    operation: AuditedOperation,
    scope: ExecutionScope,
    produceRecords: RecordProducer,
  ) => Promise<OperationOutcome>;
  /** The error the caller receives when a step other than the caller's own mutation fails */
  readonly auditFailure: (operation: AuditedOperation, error: Error) => Error;
}

export const createExecutor = <TPrepared, TExecuted>(
  steps: OperationSteps<TPrepared, TExecuted>,
  auditFailure: OperationExecutor['auditFailure'],
): OperationExecutor => ({
  run: async (operation, scope, produceRecords) => {
    const prepared = await steps.prepare(operation, scope);
    const executed = await steps.execute(operation, scope, prepared);
    const events = await steps.collect(operation, scope, prepared, executed);
    const records = await produceRecords(events, scope);
    const result = await steps.result(operation, scope, executed);
    return { result, records };
  },
  auditFailure,
});
