/**
 * Nested Delete Operation Handler
 *
 * Collects delete targets from pre-fetched before states.
 * Falls back to extracting entity ID from operation data when prefetch is unavailable.
 * Enrichment and audit log building are handled by the batch pipeline in audit-log-builder.ts.
 */

import { AUDIT_ACTION, nestedLog } from '@kuruwic/prisma-audit-core';

import { extractDeleteOperationEntityId } from '../../utils/extension-utils.js';
import type { CollectedNestedRecord } from './collected-record.js';

/** Build a minimal entity record from a serialized entityId and PK field names */
const buildMinimalEntity = (entityId: string, pkFields?: string[]): Record<string, unknown> => {
  if (entityId === '__default__') return {};

  const fields = pkFields ?? ['id'];
  if (fields.length === 1) {
    return { [fields[0] as string]: entityId };
  }
  try {
    const parsed: unknown = JSON.parse(entityId);
    if (Array.isArray(parsed) && parsed.length === fields.length) {
      const entity: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i++) {
        entity[fields[i] as string] = parsed[i];
      }
      return entity;
    }
  } catch {
    // Composite PK but not valid JSON — cannot reconstruct fully
  }
  return { [fields[0] as string]: entityId };
};

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
 * Collect delete targets from pre-fetched results or operation data.
 *
 * Priority:
 *   1. Use pre-fetched before states (has full record data)
 *   2. Fallback: extract entity ID from nestedOp.data (minimal record only)
 *
 * @returns Collected records ready for batch enrichment and audit log building
 */
export const collectDeleteRecords = (
  nestedOp: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  pkFields?: string[],
): CollectedNestedRecord[] => {
  nestedLog('delete operation detected, collecting targets');

  const pathMap = nestedPreFetchResults?.get(nestedOp.path);

  // Use pre-fetched results when available
  if (pathMap && pathMap.size > 0) {
    const collected: CollectedNestedRecord[] = [];

    for (const [entityId, preFetchResult] of pathMap) {
      if (entityId === '__default__' && pathMap.size > 1) {
        continue;
      }

      const beforeState = preFetchResult.before;
      // Use beforeState as entity when available, otherwise build from entityId + pkFields
      const entity: Record<string, unknown> = beforeState ?? buildMinimalEntity(entityId, pkFields);

      collected.push({
        entity,
        action: AUDIT_ACTION.DELETE,
        beforeState,
        relatedModel: nestedOp.relatedModel,
      });

      nestedLog('collected delete target from prefetch: path=%s entityId=%s', nestedOp.path, entityId);
    }

    return collected;
  }

  // Fallback: extract ID from operation data when prefetch is unavailable
  nestedLog('no pre-fetch results for path=%s, falling back to operation data', nestedOp.path);

  const entityId = extractDeleteOperationEntityId(nestedOp.data, pkFields);
  if (!entityId) {
    nestedLog('could not extract entity ID from delete operation data');
    return [];
  }

  return [
    {
      entity: buildMinimalEntity(entityId, pkFields),
      action: AUDIT_ACTION.DELETE,
      beforeState: null,
      relatedModel: nestedOp.relatedModel,
    },
  ];
};
