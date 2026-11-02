/**
 * Tells a failure of the caller's own database mutation (e.g. a unique constraint violation)
 * apart from a failure of the audit-support work around it (the before-state and nested
 * pre-fetches, event collection, record production). `pipeline/run-audited-operation.ts` uses
 * this pair to let the caller's failure propagate untouched instead of routing it through the
 * audit observer.
 *
 * The caller's failure travels through the executor wrapped in a `CallerMutationFailure`, so the
 * value it threw is never modified: it may be frozen, or not an `Error` at all.
 *
 * @module utils/caller-mutation-failure
 */

class CallerMutationFailure extends Error {
  constructor(readonly thrown: unknown) {
    super("The caller's own mutation failed", { cause: thrown });
    this.name = 'CallerMutationFailure';
  }
}

export const runCallerMutation = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (thrown) {
    throw new CallerMutationFailure(thrown);
  }
};

/**
 * The failure {@link runCallerMutation} wrapped the caller's thrown value in, when `error` is one.
 */
export const callerMutationFailureOf = (error: unknown): { readonly thrown: unknown } | undefined =>
  error instanceof CallerMutationFailure ? error : undefined;
