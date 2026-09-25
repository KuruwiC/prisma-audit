/**
 * Pre-fetch Selection
 *
 * Selects the nested write operations whose before state is pre-fetched, and orders them
 * parents first.
 *
 * @module grammar/pre-fetch-selection
 */

import { isNestedBatchKeyword, type NestedOperationInfo } from './nested-operations.js';

export type OperationPreFetchConfig = {
  fetchBeforeOperation: boolean;
};

export type GetOperationConfig = (modelName: string, operation: string) => OperationPreFetchConfig;

/**
 * Filters nested operations to identify those requiring pre-fetch.
 * Upsert and connectOrCreate always require pre-fetch.
 * Update and delete operations require pre-fetch only if configured.
 *
 * `updateMany` / `deleteMany` are always pre-fetched: their rows are the rows their filter
 * matches under the parent rows, which nothing but a read ahead of the write can tell, so the
 * audit needs at least the primary keys of those rows. Whether that read also carries the rows'
 * before-state follows the configuration of `update` (for `updateMany`) or `delete` (for
 * `deleteMany`) and is decided by the fetcher.
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

    if (isNestedBatchKeyword(op.operation)) {
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
