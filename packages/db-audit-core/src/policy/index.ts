/**
 * Write policy
 *
 * Decides, before the caller's operation executes, whether its audit rows are written inside
 * the same transaction as the operation. It has to be known before execution so that an adapter
 * can open an implicit transaction around the operation when the policy is atomic and none is
 * active; the core itself opens none.
 */

export interface PolicyConfig {
  /** Whether audit rows are written in the caller's transaction by default. */
  readonly awaitWrite: boolean;
  /** Per-model override of `awaitWrite`, called with the model's name and its configured tags. */
  readonly awaitWriteIf?: (modelName: string, tags: readonly string[]) => boolean;
}

export interface WritePolicy {
  /** Audit rows are written in the same transaction as the caller's operation. */
  readonly atomic: boolean;
}

export const policy = (modelName: string, tags: readonly string[], config: PolicyConfig): WritePolicy => ({
  atomic: config.awaitWriteIf ? config.awaitWriteIf(modelName, tags) : config.awaitWrite,
});
