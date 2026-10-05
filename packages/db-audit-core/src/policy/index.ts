/**
 * Write policy
 *
 * Decides, before the caller's operation executes, whether the operation is audited at all
 * (sampling) and, when it is, whether its audit rows are atomic: written, awaited, inside the
 * operation's transaction when it runs in one and once it has committed otherwise. It is known
 * before execution so that an adapter may open a transaction around an atomic operation when none
 * is active; the core itself opens none.
 */

export interface PolicyConfig {
  /** Whether audit rows are written in the caller's transaction by default. */
  readonly awaitWrite: boolean;
  /** Per-model override of `awaitWrite`, called with the model's name and its configured tags. */
  readonly awaitWriteIf?: (modelName: string, tags: readonly string[]) => boolean;
  /** Share of operations audited, from 0 (none) to 1 (every one). */
  readonly sampling: number;
  /** Per-model override of `sampling`, called with the model's name and its configured tags. */
  readonly samplingIf?: (modelName: string, tags: readonly string[]) => number;
}

/**
 * The policy of one operation: sampled out, so it writes no audit rows, or sampled in, with
 * whether its audit rows are written in the same transaction as the operation
 */
export type WritePolicy = { readonly sampled: false } | { readonly sampled: true; readonly atomic: boolean };

/**
 * Called once per audited operation. `samplingIf` (else `sampling`) gives the rate an operation is
 * sampled in with; `awaitWriteIf` (else `awaitWrite`) is consulted only for a sampled-in operation.
 */
export const policy = (modelName: string, tags: readonly string[], config: PolicyConfig): WritePolicy => {
  const rate = config.samplingIf ? config.samplingIf(modelName, tags) : config.sampling;
  if (!(Math.random() < rate)) {
    return { sampled: false };
  }
  return { sampled: true, atomic: config.awaitWriteIf ? config.awaitWriteIf(modelName, tags) : config.awaitWrite };
};
