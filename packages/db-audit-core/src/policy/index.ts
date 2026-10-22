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
  /**
   * Whether audit rows are written in the caller's transaction: a value for every operation, or a
   * function of the operation's top-level model name
   */
  readonly awaited: boolean | ((modelName: string) => boolean);
  /**
   * Share of operations audited, from 0 (none) to 1 (every one): a value for every operation, or a
   * function of the operation's top-level model name
   */
  readonly samplingRate: number | ((modelName: string) => number);
}

/**
 * The policy of one operation: sampled out, so it writes no audit rows, or sampled in, with
 * whether its audit rows are written in the same transaction as the operation
 */
export type WritePolicy = { readonly sampled: false } | { readonly sampled: true; readonly atomic: boolean };

/**
 * Called once per audited operation, with the name of its top-level model. `samplingRate` gives the
 * rate an operation is sampled in with; `awaited` is consulted only for a sampled-in operation.
 */
export const policy = (modelName: string, config: PolicyConfig): WritePolicy => {
  const rate = typeof config.samplingRate === 'function' ? config.samplingRate(modelName) : config.samplingRate;
  if (!(Math.random() < rate)) {
    return { sampled: false };
  }
  return { sampled: true, atomic: typeof config.awaited === 'function' ? config.awaited(modelName) : config.awaited };
};
