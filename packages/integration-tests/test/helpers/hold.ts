/**
 * A step a test holds until it releases it, to force an interleaving without timing: the code
 * under test awaits `hold()` at the step, the test awaits `reached` to know the step is held, does
 * what has to happen meanwhile, then calls `release()`.
 */

export interface Hold {
  /**
   * Settles once `hold()` has been called: rejects when it is not called within the hold's time
   * limit
   */
  readonly reached: Promise<void>;
  /** Signals `reached`, then waits until the test releases the step */
  readonly hold: () => Promise<void>;
  /** Lets the held step go on, or lets it pass at once when it has not been reached; idempotent */
  readonly release: () => void;
}

const DEFAULT_REACH_TIMEOUT_MS = 10_000;

export const createHold = (step: string, { reachTimeoutMs = DEFAULT_REACH_TIMEOUT_MS } = {}): Hold => {
  let onReached = () => {};
  let onTimedOut: (error: Error) => void = () => {};
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve, reject) => {
    onReached = resolve;
    onTimedOut = reject;
  });
  const timer = setTimeout(
    () => onTimedOut(new Error(`hold: ${step} was not reached within ${reachTimeoutMs}ms`)),
    reachTimeoutMs,
  );
  const reachedOrTimedOut = reached.finally(() => clearTimeout(timer));
  // A test that fails before awaiting `reached` must not leave an unhandled rejection behind
  reachedOrTimedOut.catch(() => {});
  return {
    reached: reachedOrTimedOut,
    hold: async () => {
      onReached();
      await released;
    },
    release: () => {
      clearTimeout(timer);
      release();
    },
  };
};

/**
 * Resolves once the microtasks queued so far, and those they queue, have run: what an operation
 * does before its next I/O has happened by then
 */
export const afterPendingMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
