/**
 * Tags an error as coming from the caller's own database mutation (a real `create`,
 * `update`, or `delete` on their data — e.g. a unique constraint violation), as
 * opposed to the audit-support work around it (before-fetch, after-refetch,
 * `runBatchPipeline`, the lifecycle pipeline's enrich/build stages). `extension.ts`'s
 * `executeBatch` and `executeAuditedOperation` (`lifecycle/operation-handlers/operation-executor.ts`,
 * the single-operation path) both use this pair to let such an error propagate
 * untouched instead of routing it through the audit observer or policy.
 *
 * Module-scoped (not per-`createAuditLogExtension`-call) because the tag carries no
 * per-instance state — one process-wide private symbol is simpler than threading it
 * through every extension instance's closure, and every instance still agrees on the
 * same tag.
 *
 * @module utils/caller-mutation-error
 */
const CALLER_MUTATION_ERROR = Symbol('callerMutationError');

/** Runs `fn`, tagging any error it throws as {@link CALLER_MUTATION_ERROR}. */
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
