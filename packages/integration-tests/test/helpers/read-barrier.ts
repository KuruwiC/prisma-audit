/**
 * A barrier that holds one read after it returns, for a Prisma Client Extension applied to the
 * base client before the audit extension:
 *
 *   rawPrisma.$extends({ name: 'read-barrier', query: barrier.query })
 *
 * Armed for a model and a `findUnique` or `findMany`, the next matching read runs, then waits until
 * the barrier is released before it returns. The audit reads a row's before state, the rows a batch
 * operation touches and the children a nested create sits beside with these finds, while Prisma's
 * own execution of a write does not call them, so the barrier stops the operation after its audit
 * read and before its write: another client can commit in between, after the state the audit
 * records was read.
 */

export type BarrierRead = 'findUnique' | 'findMany';

export interface BarrierTarget {
  readonly model: string;
  readonly read: BarrierRead;
  /** Narrows the target to reads whose arguments it accepts, among several reads of the same model */
  readonly match?: (args: unknown) => boolean;
}

export interface ArmedBarrier {
  /**
   * Settles once the target read has returned and is held: rejects when the read fails, or when
   * no matching read reaches the barrier within the barrier's time limit
   */
  readonly reached: Promise<void>;
  /** Lets the held read return, or disarms the barrier when no read has reached it; idempotent */
  readonly release: () => void;
}

interface Armed {
  readonly target: BarrierTarget;
  readonly onReached: () => void;
  readonly onReadFailed: (error: unknown) => void;
  readonly released: Promise<void>;
}

interface QueryParams {
  readonly model?: string;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
}

const DEFAULT_REACH_TIMEOUT_MS = 10_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

export const createReadBarrier = ({ reachTimeoutMs = DEFAULT_REACH_TIMEOUT_MS } = {}) => {
  let armed: Armed | undefined;

  const matches = (pending: Armed, { model, operation, args }: QueryParams): boolean =>
    pending.target.model === model &&
    pending.target.read === operation &&
    (pending.target.match === undefined || pending.target.match(args));

  const $allOperations = async (params: QueryParams): Promise<unknown> => {
    const pending = armed;
    if (pending === undefined || !matches(pending, params)) {
      return params.query(params.args);
    }
    armed = undefined;
    let result: unknown;
    try {
      result = await params.query(params.args);
    } catch (error) {
      pending.onReadFailed(error);
      throw error;
    }
    pending.onReached();
    await pending.released;
    return result;
  };

  const arm = (target: BarrierTarget): ArmedBarrier => {
    if (armed !== undefined) {
      throw new Error('read barrier: already armed');
    }
    const released = deferred<void>();
    const reached = deferred<void>();
    const self: Armed = {
      target,
      onReached: reached.resolve,
      onReadFailed: reached.reject,
      released: released.promise,
    };
    armed = self;
    const disarm = () => {
      if (armed === self) {
        armed = undefined;
      }
    };
    const timer = setTimeout(() => {
      disarm();
      reached.reject(
        new Error(
          `read barrier: no ${target.model}.${target.read} of the audit reached the barrier within ${reachTimeoutMs}ms`,
        ),
      );
    }, reachTimeoutMs);
    const reachedOrTimedOut = reached.promise.finally(() => clearTimeout(timer));
    // A test that fails before awaiting `reached` must not leave an unhandled rejection behind
    reachedOrTimedOut.catch(() => {});
    return {
      reached: reachedOrTimedOut,
      release: () => {
        disarm();
        clearTimeout(timer);
        released.resolve();
      },
    };
  };

  return {
    query: { $allModels: { $allOperations } },
    arm,
  };
};

export type ReadBarrier = ReturnType<typeof createReadBarrier>;

export type Settled<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );

export interface Interleaving<T> {
  readonly operation: () => Promise<T>;
  readonly interleaved: () => Promise<unknown>;
  /**
   * Whether the interleaved write completes before the held read is released (the default). False
   * for a write that blocks on a lock the operation holds: it starts while the operation is held.
   */
  readonly awaitInterleaved?: boolean;
}

export interface Interleaved<T> {
  readonly operation: Settled<T>;
  readonly interleaved: Settled<unknown>;
}

/**
 * Runs `operation` until its audit read matching `target` returns and is held, runs `interleaved`
 * while it is held, then releases it and waits for both to settle. The read is released whatever
 * happens, so no transaction stays open holding a lock the other waits on. Fails when the
 * operation settles, or the barrier times out, before the read is held.
 */
export const interleave = async <T>(
  barrier: ReadBarrier,
  target: BarrierTarget,
  { operation, interleaved, awaitInterleaved = true }: Interleaving<T>,
): Promise<Interleaved<T>> => {
  const gate = barrier.arm(target);
  const operationSettled = settle(operation());
  try {
    const settledFirst = operationSettled.then((outcome) => {
      throw new Error(
        `read barrier: the operation settled (${outcome.status}) before its ${target.model}.${target.read} reached the barrier`,
        { cause: outcome.status === 'rejected' ? outcome.reason : undefined },
      );
    });
    settledFirst.catch(() => {});
    await Promise.race([gate.reached, settledFirst]);
    const interleavedSettled = settle(interleaved());
    if (awaitInterleaved) {
      await interleavedSettled;
    }
    gate.release();
    return { operation: await operationSettled, interleaved: await interleavedSettled };
  } finally {
    gate.release();
    await operationSettled;
  }
};
