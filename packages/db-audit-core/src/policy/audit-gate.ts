/**
 * Audit gate
 *
 * Decides whether a write goes through the audit at all: whether it writes rows of an audited
 * model, and, when it does, whether it may run without an audit context. It is the coverage
 * decision, apart from the write policy (`policy()`), which decides how much of what goes through
 * the audit is recorded and how. The gate runs before the write policy and is not affected by it:
 * a write the gate rejects is rejected at any sampling rate.
 */

export interface AuditGateConfig {
  /**
   * Whether a write to the model fails when no audit context is set, instead of running
   * unaudited: a value for every model, or a function of the model name
   */
  readonly requireContext: boolean | ((modelName: string) => boolean);
}

/**
 * - `audit`: the write goes through the audit, its write policy deciding what is recorded
 * - `skip`: the write runs unaudited
 * - `reject`: the write must not run; `modelName` is the audited model it writes that requires an
 *   audit context
 */
export type AuditGate =
  | { readonly kind: 'audit' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'reject'; readonly modelName: string };

/**
 * Decides whether a write goes through the audit, before any sampling. A write that writes rows
 * of no audited model is skipped. Otherwise it is audited when an audit context is set; without
 * one it is rejected when one of those models requires a context, and runs unaudited otherwise.
 *
 * @param auditedModels - The audited models the write writes rows of, its nested writes
 *   included; the adapter derives them from the write and the entity map
 */
export const auditGate = (
  hasContext: boolean,
  auditedModels: readonly string[],
  config: AuditGateConfig,
): AuditGate => {
  if (auditedModels.length === 0) {
    return { kind: 'skip' };
  }
  if (hasContext) {
    return { kind: 'audit' };
  }
  const { requireContext } = config;
  const required = auditedModels.find((modelName) =>
    typeof requireContext === 'function' ? requireContext(modelName) : requireContext,
  );
  return required === undefined ? { kind: 'skip' } : { kind: 'reject', modelName: required };
};

/** The write that an `AuditGate` of kind `reject` stopped */
export interface RejectedWrite {
  /** The audited model the write writes rows of that requires an audit context */
  readonly modelName: string;
  /** The model of the operation that writes it, which is `modelName` unless the row is written by a nested write */
  readonly operationModelName: string;
  readonly operation: string;
}

/** Thrown by an adapter, before the write runs, for a write the audit gate rejects */
export class AuditContextMissingError extends Error {
  readonly modelName: string;
  readonly operationModelName: string;
  readonly operation: string;

  constructor({ modelName, operationModelName, operation }: RejectedWrite) {
    super(
      `A write to ${modelName} was rejected: no audit context is set, and requireContext requires one for ${modelName} (operation ${operation} on ${operationModelName})`,
    );
    this.name = 'AuditContextMissingError';
    this.modelName = modelName;
    this.operationModelName = operationModelName;
    this.operation = operation;
  }
}
