/**
 * Tags an error as coming from the caller's own database mutation (e.g. a unique
 * constraint violation), as opposed to the audit-support work around it (the before-state
 * and nested pre-fetches, event collection, record production).
 * `pipeline/run-audited-operation.ts` uses this pair to let such an error propagate
 * untouched instead of routing it through the audit observer or policy.
 *
 * The symbol is module-scoped because the tag carries no per-extension-instance state.
 *
 * @module utils/caller-mutation-error
 */
const CALLER_MUTATION_ERROR = Symbol('callerMutationError');

/** Runs `fn`, tagging any `Error` it throws; a non-`Error` throw is rethrown untagged. */
export const runCallerMutation = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (caughtError) {
    if (caughtError instanceof Error) {
      (caughtError as Error & { [CALLER_MUTATION_ERROR]?: true })[CALLER_MUTATION_ERROR] = true;
    }
    throw caughtError;
  }
};

/** True when `error` was tagged by {@link runCallerMutation}. */
export const isCallerMutationError = (error: unknown): boolean => {
  return (
    error instanceof Error && (error as Error & { [CALLER_MUTATION_ERROR]?: true })[CALLER_MUTATION_ERROR] === true
  );
};
