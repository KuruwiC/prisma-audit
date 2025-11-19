/**
 * Nested Operation State Resolver
 *
 * Resolves the action (create/update/delete/connect) and before state
 * for nested operations based on operation type and pre-fetched data.
 */

import {
  AUDIT_ACTION,
  type NestedPreFetchResult,
  resolveConnectOrCreateState,
  resolveCreateState,
  resolveUpdateState,
  resolveUpsertState,
} from '@kuruwic/prisma-audit-core';
import type { PrismaAction } from '../../types.js';
import type { NestedOperationInfo, NestedPreFetchResults } from './delete-handler.js';

/**
 * Configuration for nested operations (update/delete)
 */
export type NestedOperationConfig = {
  fetchBeforeOperation: boolean;
};

/**
 * Function to get nested operation configuration
 */
export type GetNestedOperationConfig = (modelName: string, operation: string) => NestedOperationConfig;

/**
 * Resolved state result
 * - action: The determined action (create/update/delete/connect)
 * - beforeState: The before state (or null if not available/applicable)
 *
 * Special case: action === 'connect' signals that audit log should be skipped
 */
export type ResolvedState = {
  action: PrismaAction;
  beforeState: Record<string, unknown> | null;
};

/**
 * Get pre-fetch result from nested Map structure
 *
 * Tries specific entityId first, then falls back to '__default__'.
 */
const getPreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  entityId: string,
): NestedPreFetchResult | undefined => {
  const pathMap = nestedPreFetchResults?.get(path);
  if (!pathMap) return undefined;

  // Try specific entityId first, then fallback to __default__
  return pathMap.get(entityId) || pathMap.get('__default__');
};

const resolveUpdateOperation = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  entityId: string,
): ResolvedState => {
  const resolved = resolveUpdateState(
    getPreFetchResult(nestedPreFetchResults, path, entityId),
    null, // afterRecord is not used for action determination
  );
  return {
    action: resolved.action,
    beforeState: resolved.before,
  };
};

const resolveUpsertOperation = (
  nestedOp: NestedOperationInfo,
  entityId: string,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  getNestedOperationConfig: GetNestedOperationConfig,
): ResolvedState => {
  const config = getNestedOperationConfig(nestedOp.relatedModel, 'update');
  const preFetchResult = getPreFetchResult(nestedPreFetchResults, nestedOp.path, entityId);

  if (preFetchResult !== undefined) {
    const resolved = resolveUpsertState(preFetchResult, null);
    const shouldIncludeBeforeState = config.fetchBeforeOperation && resolved.action === AUDIT_ACTION.UPDATE;

    return {
      action: resolved.action,
      beforeState: shouldIncludeBeforeState ? resolved.before : null,
    };
  }

  // Fallback: No pre-fetch result (shouldn't happen but handle gracefully)
  return {
    action: AUDIT_ACTION.CREATE,
    beforeState: null,
  };
};

const resolveConnectOrCreateOperation = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  entityId: string,
): ResolvedState => {
  const preFetchResult = getPreFetchResult(nestedPreFetchResults, path, entityId);
  const resolved = resolveConnectOrCreateState(preFetchResult, null);

  if (resolved === null) {
    // Record existed - this was a connect operation
    return {
      action: 'connect' as PrismaAction,
      beforeState: null,
    };
  }

  // Record did not exist - this was a create operation
  return {
    action: resolved.action,
    beforeState: null,
  };
};

const resolveConnectOperation = (): ResolvedState => {
  return {
    action: 'connect' as PrismaAction,
    beforeState: null,
  };
};

const resolveCreateOperation = (): ResolvedState => {
  const resolved = resolveCreateState(null);
  return {
    action: resolved.action,
    beforeState: null,
  };
};

/**
 * Resolve action and before state for nested operations
 *
 * Determines action (create/update/delete/connect) and retrieves before state based on
 * operation type and pre-fetched data.
 *
 * **Operation behavior:**
 * - **create**: action=create, beforeState=null
 * - **update/updateMany**: action=update, beforeState from pre-fetch
 * - **upsert**: action=create/update based on record existence
 * - **connectOrCreate**: action='connect' (existing) or action=create (new)
 * - **connect**: action='connect' (skip audit log)
 * - **delete/deleteMany**: Handled separately
 *
 * @param nestedOp - Nested operation information
 * @param entityId - Entity ID for map lookup
 * @param nestedPreFetchResults - Pre-fetched before states
 * @param getNestedOperationConfig - Config getter function
 * @returns Resolved action and before state
 *
 * @example
 * ```typescript
 * const { action, beforeState } = resolveNestedOperationState(
 *   { operation: 'upsert', path: 'user', relatedModel: 'User', fieldName: 'user' },
 *   '1', preFetchResults, getNestedOperationConfig
 * );
 * // action === 'update', beforeState === { id: 1, name: 'old' }
 * ```
 */
export const resolveNestedOperationState = (
  nestedOp: NestedOperationInfo,
  entityId: string,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  getNestedOperationConfig: GetNestedOperationConfig,
): ResolvedState => {
  if (nestedOp.operation === 'update' || nestedOp.operation === 'updateMany') {
    return resolveUpdateOperation(nestedPreFetchResults, nestedOp.path, entityId);
  }

  if (nestedOp.operation === 'upsert') {
    return resolveUpsertOperation(nestedOp, entityId, nestedPreFetchResults, getNestedOperationConfig);
  }

  if (nestedOp.operation === 'connectOrCreate') {
    return resolveConnectOrCreateOperation(nestedPreFetchResults, nestedOp.path, entityId);
  }

  if (nestedOp.operation === 'connect') {
    return resolveConnectOperation();
  }

  return resolveCreateOperation();
};
