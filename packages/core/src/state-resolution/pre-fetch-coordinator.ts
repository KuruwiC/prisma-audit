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

    if (op.operation === 'update' || op.operation === 'updateMany') {
      const config = getConfig(op.relatedModel, 'update');
      return config.fetchBeforeOperation;
    }

    if (op.operation === 'delete' || op.operation === 'deleteMany') {
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
