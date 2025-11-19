/**
 * Nested Delete Operation Handler
 *
 * Handles delete and deleteMany nested operations by extracting entity IDs,
 * retrieving pre-fetched before states, and generating audit logs.
 */

import type { AggregateConfigService, AuditContext, RedactConfig } from '@kuruwic/prisma-audit-core';
import { AUDIT_ACTION, batchEnrichEntityContexts, nestedLog } from '@kuruwic/prisma-audit-core';
import { buildAuditLog } from '../../audit-log-builder/index.js';
import { createPrismaClientManager } from '../../client-manager/index.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { AuditLogData } from '../../types.js';
import { extractDeleteOperationEntityId } from '../../utils/extension-utils.js';

/**
 * Nested operation information
 */
export type NestedOperationInfo = {
  operation: string;
  fieldName: string;
  relatedModel: string;
  data: unknown;
  path: string;
};

/**
 * Pre-fetch results map structure
 * Map<path, Map<entityId, { before: Record | null }>>
 */
export type NestedPreFetchResults = Map<string, Map<string, { before: Record<string, unknown> | null }>>;

/**
 * Dependencies required for handling nested delete operations
 */
export type DeleteHandlerDependencies = {
  aggregateConfig: AggregateConfigService;
  excludeFields: string[];
  redact: RedactConfig | undefined;
  basePrisma: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
};

/**
 * Handles delete/deleteMany nested operations
 *
 * Processes nested delete by extracting entity ID, retrieving pre-fetched before state,
 * enriching entity context, and building audit logs.
 *
 * NOTE: aggregateContext is no longer enriched here. It is now enriched per aggregate root
 * inside buildAuditLog for aggregate-aware context.
 *
 * @param nestedOp - Nested operation information
 * @param context - Audit context
 * @param actorContext - Pre-enriched actor context
 * @param nestedPreFetchResults - Pre-fetched before states
 * @param deps - Dependencies (aggregateConfig, excludeFields, redact, basePrisma)
 * @returns Audit logs for deleted records
 *
 * @example
 * ```typescript
 * const logs = await handleNestedDelete(
 *   { operation: 'delete', fieldName: 'posts', relatedModel: 'Post', data: { id: 1 }, path: 'posts' },
 *   context, actorContext, preFetchResults, deps
 * );
 * ```
 */
export const handleNestedDelete = async (
  nestedOp: NestedOperationInfo,
  context: AuditContext,
  actorContext: unknown,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  deps: DeleteHandlerDependencies,
): Promise<AuditLogData[]> => {
  const { aggregateConfig, excludeFields, redact, basePrisma } = deps;

  nestedLog('delete operation detected, extracting ID from operation data');

  const entityId = extractDeleteOperationEntityId(nestedOp.data);
  if (!entityId) {
    return [];
  }

  let beforeState: Record<string, unknown> | null = null;

  const pathMap = nestedPreFetchResults?.get(nestedOp.path);
  const preFetchResult = pathMap?.get(entityId) || pathMap?.get('__default__');

  if (preFetchResult !== undefined) {
    beforeState = preFetchResult.before;
  }

  const minimalRecord = { id: entityId };
  const nestedEntityConfig = aggregateConfig.getEntityConfig(nestedOp.relatedModel);

  // Enrich entity context (shared across all aggregates)
  const tempMeta = {
    aggregateType: nestedOp.relatedModel,
    aggregateCategory: 'model',
  };

  const [nestedEntityContext] = nestedEntityConfig
    ? await batchEnrichEntityContexts(
        [minimalRecord as Record<string, unknown>],
        nestedEntityConfig,
        basePrisma,
        tempMeta,
      )
    : [null];

  const manager = createPrismaClientManager(basePrisma, context);
  const nestedLogs = await buildAuditLog(
    minimalRecord as Record<string, unknown>,
    AUDIT_ACTION.DELETE,
    context,
    nestedOp.relatedModel,
    manager,
    actorContext,
    nestedEntityContext,
    beforeState,
    aggregateConfig,
    excludeFields,
    redact,
  );

  return nestedLogs;
};
