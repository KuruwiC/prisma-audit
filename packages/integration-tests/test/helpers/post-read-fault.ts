/**
 * A `Post.findUnique` query handler that fails on demand, for a Prisma Client Extension applied to
 * the base client before the audit extension:
 *
 *   rawPrisma.$extends({ name: 'fault-injection', query: { post: { findUnique: fault.findUnique } } })
 *
 * The audit extension reads a row's before state with `findUnique`, so arming the failure makes only
 * that audit read fail: Prisma's own execution of an update or delete does not call the JS-level
 * `findUnique`.
 */

export const createPostReadFault = (failureMessage: string) => {
  let failNextFindUnique = false;

  return {
    findUnique: async <Args, Result>({
      args,
      query,
    }: {
      args: Args;
      query: (args: Args) => Promise<Result>;
    }): Promise<Result> => {
      if (failNextFindUnique) {
        failNextFindUnique = false;
        throw new Error(failureMessage);
      }
      return query(args);
    },
    armFindUniqueFailure: () => {
      failNextFindUnique = true;
    },
  };
};
