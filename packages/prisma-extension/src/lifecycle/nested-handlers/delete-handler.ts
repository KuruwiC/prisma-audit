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

/**
 * Build a minimal entity record from a serialized entityId and PK field names.
 *
 * Returns `null` when the row's identity could not be resolved at all, rather than a
 * partial or empty guess:
 *   - `entityId === '__default__'` — pre-fetch never determined a primary key for this
 *     row (pre-fetch failed, or the WHERE clause exposed no recognizable PK fields). An
 *     empty `{}` here would look like a valid, complete identity to anyone reading the
 *     audit log — the idResolver would read missing fields off it and serialize a
 *     plausible-looking-but-fabricated id (e.g. `"[null,null]"` for a two-field key).
 *   - a composite entityId cannot be reconstructed to its full key (not valid JSON, or
 *     the parsed array length does not match `pkFields`). This mirrors the core sibling
 *     `deserializeEntityId` in `packages/core/src/utils/nested-operations.ts` (used to
 *     build WHERE clauses), which also returns `null` instead of a partial key — a
 *     `{ [firstField]: entityId }` guess here would look complete when most of the
 *     composite key is actually unknown.
 */
const buildMinimalEntity = (entityId: string, pkFields?: string[]): Record<string, unknown> | null => {
  if (entityId === '__default__') return null;

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
    // Composite PK but not valid JSON — cannot reconstruct
  }
  return null;
};

/**
 * Notification for a nested delete whose entityId could not be resolved to a
 * primary key. Mirrors the shape `onAuditErrorHandler` expects (see
 * `dispatchAuditError` in extension.ts) so callers can forward it unchanged.
 */
export interface UnresolvedDeleteEntityId {
  relatedModel: string;
  entityId: string;
  pkFields: string[];
  error: Error;
}

export type UnresolvedDeleteEntityIdReporter = (info: UnresolvedDeleteEntityId) => void;

/** Notify `onUnresolvedEntityId` (if provided) that an entityId could not be resolved. */
const reportUnresolvedEntityId = (
  relatedModel: string,
  entityId: string,
  pkFields: string[] | undefined,
  onUnresolvedEntityId: UnresolvedDeleteEntityIdReporter | undefined,
): void => {
  if (!onUnresolvedEntityId) return;

  const fields = pkFields ?? ['id'];
  onUnresolvedEntityId({
    relatedModel,
    entityId,
    pkFields: fields,
    error: new Error(
      `[@prisma-audit] Cannot resolve the primary key of a deleted ${relatedModel} record ` +
        `(entityId="${entityId}", pkFields=[${fields.join(', ')}]). Skipping this delete's audit log entry ` +
        'instead of recording a fabricated identity.',
    ),
  });
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
 * An entityId that cannot be resolved to a full primary key (see `buildMinimalEntity`)
 * is never recorded as a partial/guessed or empty identity: that record is skipped
 * and, if `onUnresolvedEntityId` is provided, reported through it instead.
 *
 * @returns Collected records ready for batch enrichment and audit log building
 */
export const collectDeleteRecords = (
  nestedOp: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  pkFields?: string[],
  onUnresolvedEntityId?: UnresolvedDeleteEntityIdReporter,
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
      const entity = beforeState ?? buildMinimalEntity(entityId, pkFields);

      if (entity === null) {
        nestedLog(
          'cannot resolve primary key for entityId=%s (path=%s); skipping delete audit entry',
          entityId,
          nestedOp.path,
        );
        reportUnresolvedEntityId(nestedOp.relatedModel, entityId, pkFields, onUnresolvedEntityId);
        continue;
      }

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

  const entity = buildMinimalEntity(entityId, pkFields);
  if (entity === null) {
    nestedLog(
      'cannot reconstruct composite primary key for entityId=%s (path=%s); skipping delete audit entry',
      entityId,
      nestedOp.path,
    );
    reportUnresolvedEntityId(nestedOp.relatedModel, entityId, pkFields, onUnresolvedEntityId);
    return [];
  }

  return [
    {
      entity,
      action: AUDIT_ACTION.DELETE,
      beforeState: null,
      relatedModel: nestedOp.relatedModel,
    },
  ];
};
