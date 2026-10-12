/** A lazy operation, as Prisma's operations are: it runs, once, when it is awaited */
export const lazyOperation = (run: () => unknown) => {
  let started: Promise<unknown> | undefined;
  return {
    [Symbol.toStringTag]: 'PrismaPromise',
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
      started ??= Promise.resolve().then(run);
      return started.then(onFulfilled, onRejected);
    },
  };
};
