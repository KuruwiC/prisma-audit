/**
 * Audit gate
 *
 * Decides whether a write goes through the audit at all: whether it writes rows of an audited
 * model, and, when it does, whether it is the caller's write and whether it may run without an
 * audit context. A write a callback of the audit issues while the audit processes an operation is
 * not the caller's: it would go unaudited, so it is rejected. It is the coverage decision, apart
 * from the write policy (`policy()`), which decides how what goes through the audit is written. The
 * gate runs before the write policy and is not affected by it: a write the gate rejects is rejected
 * whatever its write mode.
 */

import type { AuditContext } from '../types.js';

export interface AuditGateConfig {
  /**
   * Whether a write to the model fails when no audit context is set, instead of running
   * unaudited: a value for every model, or a function of the model name. Unset, every audited model
   * requires one.
   */
  readonly requireContext?: boolean | ((modelName: string) => boolean);
}

/** The write the audit gate decides on, as the adapter sees it before the write runs */
export interface AuditGateInput {
  /** The audit context set for the write, if any */
  readonly context: AuditContext | undefined;
  /**
   * The audited models the write writes rows of, its nested writes included; the adapter derives
   * them from the write and the entity map
   */
  readonly auditedModels: readonly string[];
  /**
   * Whether the write is issued while the audit processes an operation: from the async flow of the
   * audit's own reads and writes, or of a callback the audit runs (those
   * {@link AuditReentrantWriteError} lists)
   */
  readonly withinAudit: boolean;
}

/**
 * - `audit`: the write goes through the audit under `context`, its write policy deciding how its
 *   records are written
 * - `skip`: the write writes rows of no audited model, and runs outside the audit
 * - `unaudited`: the write writes rows of audited models and runs unaudited, for `reason`:
 *   `no-context`, no audit context is set and none of those models requires one
 * - `reject`: the write must not run; `modelName` is the audited model it writes that requires an
 *   audit context
 * - `reentrant`: the write must not run, and has no outcome: it writes rows of audited models, the
 *   first of which is `modelName`, and is issued while the audit processes an operation
 */
export type AuditGate =
  | { readonly kind: 'audit'; readonly context: AuditContext }
  | { readonly kind: 'skip' }
  | { readonly kind: 'unaudited'; readonly reason: 'no-context' }
  | { readonly kind: 'reject'; readonly modelName: string }
  | { readonly kind: 'reentrant'; readonly modelName: string };

/**
 * Decides whether a write goes through the audit, before its write policy. A write that writes rows
 * of no audited model is skipped. Otherwise it is reentrant when it is issued while the audit
 * processes an operation, whatever the audit context; else it is audited when an audit context is
 * set, and without one it is rejected when one of those models requires a context, and runs
 * unaudited otherwise.
 */
export const auditGate = (
  { context, auditedModels, withinAudit }: AuditGateInput,
  config: AuditGateConfig,
): AuditGate => {
  const [firstModel] = auditedModels;
  if (firstModel === undefined) {
    return { kind: 'skip' };
  }
  if (withinAudit) {
    return { kind: 'reentrant', modelName: firstModel };
  }
  if (context !== undefined) {
    return { kind: 'audit', context };
  }
  const { requireContext = true } = config;
  const required = auditedModels.find((modelName) =>
    typeof requireContext === 'function' ? requireContext(modelName) : requireContext,
  );
  return required === undefined ? { kind: 'unaudited', reason: 'no-context' } : { kind: 'reject', modelName: required };
};

/** The write a {@link RejectedWriteError} names */
export interface RejectedWrite {
  /**
   * The model the rejection names: for the gate, the audited model the write writes rows of; for an
   * adapter's own rejection decided on the top-level operation alone, the operation's model, which
   * `operationModelName` names too
   */
  readonly modelName: string;
  /** The model of the operation that writes it, which is `modelName` unless the row is written by a nested write */
  readonly operationModelName: string;
  readonly operation: string;
}

/**
 * The base of the errors an adapter throws for a write the audit rejected before it ran: those of
 * the audit gate, and those an adapter adds of its own. An enricher's `onError` cannot turn one
 * into a fallback.
 */
export abstract class RejectedWriteError extends Error {
  readonly modelName: string;
  readonly operationModelName: string;
  readonly operation: string;

  protected constructor(message: string, { modelName, operationModelName, operation }: RejectedWrite) {
    super(message);
    this.modelName = modelName;
    this.operationModelName = operationModelName;
    this.operation = operation;
  }
}

/** Thrown by an adapter, before the write runs, for a write the audit gate stops with kind `reject` */
export class AuditContextMissingError extends RejectedWriteError {
  constructor(write: RejectedWrite) {
    super(
      `A write to ${write.modelName} was rejected: no audit context is set, and requireContext requires one for ${write.modelName} (operation ${write.operation} on ${write.operationModelName}). Set an audit context for the write with the context provider's runAsync, with a system actor for a seed, migration or batch job. To run it unaudited on purpose, set requireContext to false, or to a function that returns false for ${write.modelName}.`,
      write,
    );
    this.name = 'AuditContextMissingError';
  }
}

/**
 * Thrown by an adapter, before the write runs, for a write the audit gate finds reentrant: it writes
 * rows of an audited model, and a callback the audit runs issues it while the audit processes an
 * operation. It has no outcome. A write meant to run unaudited goes through a client the audit is
 * not applied to. The guard applies when a write starts: a write a callback creates but returns
 * unstarted, as a lazy operation, runs as an ordinary write of the caller once the caller starts it,
 * so it is audited, or rejected, like any other.
 *
 * The callbacks the audit runs while it processes an operation, each of which can issue such a
 * write: the resolvers (an entity's `idResolver`, and an aggregate root's resolver from `to()`,
 * `batchLookup` included), the enrichers (of the actor, the entity and the aggregate roots) and
 * their `onError`, the serializers, the writer, and the observer.
 */
export class AuditReentrantWriteError extends RejectedWriteError {
  constructor(write: RejectedWrite) {
    super(
      `A write to ${write.modelName} was rejected: a callback the audit runs (such as a resolver, an enricher, the writer or the observer) issued it while the audit processed an operation, where it would go unaudited. Write it from the caller instead, or through a client the audit is not applied to, to write it unaudited on purpose (operation ${write.operation} on ${write.operationModelName})`,
      write,
    );
    this.name = 'AuditReentrantWriteError';
  }
}
