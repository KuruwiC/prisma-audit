/**
 * Read failures on demand, for a Prisma Client Extension applied to the base client before the
 * audit extension:
 *
 *   rawPrisma.$extends({ name: 'fault-injection', query: fault.query })
 *
 * Armed for a model and a read operation, the next matching call throws once. The audit reads a
 * row's before state, the rows a batch operation touches and the rows nested below a write with
 * these finds, while Prisma's own execution of a write does not call the JS-level methods, so
 * arming a failure makes only an audit read fail.
 */

export interface ReadFaultTarget {
  readonly model: string;
  readonly operation: 'findUnique' | 'findFirst' | 'findMany';
  /**
   * Narrows the target to calls it accepts, among several calls of the same model and operation. It
   * gets the call's arguments and its 1-indexed number among the calls of this model and operation
   * made since arming.
   */
  readonly match?: (args: unknown, callNumber: number) => boolean;
}

interface Armed {
  readonly target: ReadFaultTarget;
  readonly error: Error;
  calls: number;
}

interface QueryParams {
  readonly model?: string;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
}

export const createReadFault = () => {
  const armed: Armed[] = [];

  const $allOperations = async ({ model, operation, args, query }: QueryParams): Promise<unknown> => {
    for (const pending of armed) {
      if (pending.target.model !== model || pending.target.operation !== operation) {
        continue;
      }
      pending.calls += 1;
      if (pending.target.match === undefined || pending.target.match(args, pending.calls)) {
        armed.splice(armed.indexOf(pending), 1);
        throw pending.error;
      }
    }
    return query(args);
  };

  return {
    query: { $allModels: { $allOperations } },
    /**
     * The next call matching `target` throws `failure` once: an error to throw as it is, or the
     * message of a new one (by default `simulated <model>.<operation> failure`)
     */
    arm: (
      target: ReadFaultTarget,
      failure: string | Error = `simulated ${target.model}.${target.operation} failure`,
    ): void => {
      armed.push({ target, error: typeof failure === 'string' ? new Error(failure) : failure, calls: 0 });
    },
  };
};
