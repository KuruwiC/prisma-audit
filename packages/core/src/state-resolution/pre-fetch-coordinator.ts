/**
 * Pre-fetch Coordinator
 *
 * Filters and categorizes operations that require pre-fetching before execution.
 */

import type { NestedOperationInfo } from '../utils/nested-operations.js';

export type OperationPreFetchConfig = {
  fetchBeforeOperation: boolean;
};

export type GetOperationConfig = (modelName: string, operation: string) => OperationPreFetchConfig;

/**
 * Filters nested operations to identify those requiring pre-fetch.
 * Upsert and connectOrCreate always require pre-fetch.
 * Update and delete operations require pre-fetch only if configured.
 *
 * `updateMany` / `deleteMany` are never pre-fetched. Their WHERE clause is a
 * `ScalarWhereInput`, not a `WhereUniqueInput`, and it is not scoped to the parent relation
 * (e.g. a nested `posts: { updateMany: { where: { published: false } } } }` matches every
 * unpublished post table-wide, not just the parent's). Prisma applies that parent-relation
 * scoping internally when it executes the write; pre-fetch has no equivalent scoping, so a
 * `findFirst`/`findMany` here could return a row belonging to a different parent entirely.
 * Recording that as the "before" state would be worse than recording nothing, so these two
 * operations are always skipped — implementing this correctly would require threading the
 * parent's foreign key into the WHERE clause, which this pipeline does not do.
 *
 * @param operations - Array of detected nested operations
 * @param getConfig - Function to retrieve operation configuration
 * @returns Array of operations that require pre-fetching
 */
export const filterOperationsToPreFetch = (
  operations: readonly NestedOperationInfo[],
  getConfig: GetOperationConfig,
): NestedOperationInfo[] => {
  return operations.filter((op) => {
    if (op.operation === 'upsert') {
      return true;
    }

    if (op.operation === 'connectOrCreate') {
      return true;
    }

    if (op.operation === 'update') {
      const config = getConfig(op.relatedModel, 'update');
      return config.fetchBeforeOperation;
    }

    if (op.operation === 'delete') {
      const config = getConfig(op.relatedModel, 'delete');
      return config.fetchBeforeOperation;
    }

    return false;
  });
};

/**
 * Sorts operations by path depth (shallow to deep).
 * Ensures parent records are processed before child records in deeply nested operations.
 *
 * @param operations - Operations to sort
 * @returns Sorted operations (shallow first)
 */
export const sortByPathDepth = (operations: readonly NestedOperationInfo[]): NestedOperationInfo[] => {
  return [...operations].sort((a, b) => {
    const depthA = a.path.split('.').length;
    const depthB = b.path.split('.').length;
    return depthA - depthB;
  });
};
