/** A lazy operation, as Prisma's operations are: it runs, once, when it is awaited */
export const lazyOperation = (run: () => unknown): PromiseLike<unknown> & { readonly [Symbol.toStringTag]: string } => {
  let started: Promise<unknown> | undefined;
  return {
    [Symbol.toStringTag]: 'PrismaPromise',
    then: (onFulfilled, onRejected) => {
      started ??= Promise.resolve().then(run);
      return started.then(onFulfilled, onRejected);
    },
  };
};
