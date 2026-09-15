/**
 * Nested Delete Operation Handler
 *
 * Collects delete targets from pre-fetched before states.
 * Falls back to extracting entity ID from operation data when prefetch is unavailable.
 * Enrichment and audit log building are handled by the batch pipeline in audit-log-builder.ts.
 */

import { AUDIT_ACTION, nestedLog, type UniqueConstraint } from '@kuruwic/prisma-audit-core';

import { extractDeleteOperationEntityId } from '../../utils/extension-utils.js';
import { PRE_FETCH_DEFAULT_KEY } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';

/**
 * Build a minimal entity record from a serialized entityId and PK field names.
 *
 * Returns `null` when the full primary key cannot be recovered, so the caller skips the
 * record instead of logging a guessed identity:
 *   - `entityId === PRE_FETCH_DEFAULT_KEY` — pre-fetch never determined a primary key for this
 *     row (pre-fetch failed, or the WHERE clause exposed no recognizable PK fields). An empty
 *     `{}` would pass as a complete entity, and an idResolver reading fields off it could
 *     produce a plausible but fabricated id (e.g. `"[null,null]"` for a two-field key).
 *   - a composite entityId is not valid JSON, or its parsed array length does not match
 *     `pkFields`. A `{ [firstField]: entityId }` guess would look complete while most of the
 *     key is unknown. Same contract as core's `deserializeEntityId`
 *     (`packages/core/src/utils/nested-operations.ts`), which also returns `null` here.
 */
const buildMinimalEntity = (entityId: string, pkFields?: string[]): Record<string, unknown> | null => {
  if (entityId === PRE_FETCH_DEFAULT_KEY) return null;

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
 * A nested delete skipped because its primary key could not be resolved. `entityId` is the
 * raw serialized key, or `PRE_FETCH_DEFAULT_KEY` when no identity was ever determined.
 * extension.ts maps these fields into an `entity-id-resolution` observer context.
 */
export interface UnresolvedDeleteEntityId {
  relatedModel: string;
  entityId: string;
  pkFields: string[];
  error: Error;
}

export type UnresolvedDeleteEntityIdReporter = (info: UnresolvedDeleteEntityId) => Promise<void>;

/**
 * Notify `onUnresolvedDeleteEntityId` (if provided) that an entityId could not be
 * resolved. Awaited by every caller rather than fired-and-forgotten, so the reporter
 * (which in practice forwards to the async error-handling observer) is never lost in a
 * short-lived runtime.
 */
const reportUnresolvedEntityId = async (
  relatedModel: string,
  entityId: string,
  pkFields: string[] | undefined,
  onUnresolvedDeleteEntityId: UnresolvedDeleteEntityIdReporter | undefined,
): Promise<void> => {
  if (!onUnresolvedDeleteEntityId) return;

  const fields = pkFields ?? ['id'];
  await onUnresolvedDeleteEntityId({
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
 * A delete whose primary key cannot be fully resolved (see `buildMinimalEntity`), or whose
 * operation data yields no entityId at all, is skipped rather than recorded with a partial
 * or empty identity, and reported through `onUnresolvedDeleteEntityId` when provided.
 *
 * **Exception — nested `deleteMany` with no extractable entityId.** Nested `deleteMany` is
 * never pre-fetched (see `filterOperationsToPreFetch` in `@kuruwic/prisma-audit-core`), and
 * a filter WHERE such as `{ published: false }` names no single row, so finding no entityId
 * is expected rather than a resolution failure. Reporting it would flag every ordinary
 * nested `deleteMany` as an audit failure, so it is only debug-logged. A `deleteMany` whose
 * WHERE names the PK fields directly (e.g. `{ id: 'x' }`) still resolves an entityId and
 * follows the normal fallback path.
 *
 * @param pkConstraint - The deleted model's primary key (`getPrimaryKeyConstraint`). Its
 *   fields rebuild an entity from a serialized entityId; the whole constraint, including its
 *   declared name, is what the fallback unwraps a compound-unique WHERE clause with.
 *   Defaults to a single `id` field.
 * @returns Collected records ready for batch enrichment and audit log building
 */
export const collectDeleteRecords = async (
  nestedOp: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  pkConstraint?: UniqueConstraint,
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter,
): Promise<CollectedNestedRecord[]> => {
  nestedLog('delete operation detected, collecting targets');

  const pkFields = pkConstraint?.fields;

  const pathMap = nestedPreFetchResults?.get(nestedOp.path);

  // Use pre-fetched results when available
  if (pathMap && pathMap.size > 0) {
    const collected: CollectedNestedRecord[] = [];

    for (const [entityId, preFetchResult] of pathMap) {
      const beforeState = preFetchResult.before;
      // Use beforeState as entity when available, otherwise build from entityId + pkFields
      const entity = beforeState ?? buildMinimalEntity(entityId, pkFields);

      if (entity === null) {
        nestedLog(
          'cannot resolve primary key for entityId=%s (path=%s); skipping delete audit entry',
          entityId,
          nestedOp.path,
        );
        await reportUnresolvedEntityId(nestedOp.relatedModel, entityId, pkFields, onUnresolvedDeleteEntityId);
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

  const entityId = extractDeleteOperationEntityId(nestedOp.data, pkConstraint);
  if (!entityId) {
    if (nestedOp.operation === 'deleteMany') {
      // Expected for a filter WHERE — see the `deleteMany` exception in the JSDoc above.
      nestedLog(
        'nested deleteMany has no single-row identity to resolve (path=%s); no audit entry, no observer notification',
        nestedOp.path,
      );
      return [];
    }

    nestedLog('could not extract entity ID from delete operation data');
    // No raw entityId exists here; report the `PRE_FETCH_DEFAULT_KEY` sentinel ("identity
    // never determined") so the observer can tell this apart from a malformed composite
    // key, which is reported with its raw value.
    await reportUnresolvedEntityId(nestedOp.relatedModel, PRE_FETCH_DEFAULT_KEY, pkFields, onUnresolvedDeleteEntityId);
    return [];
  }

  const entity = buildMinimalEntity(entityId, pkFields);
  if (entity === null) {
    nestedLog(
      'cannot reconstruct composite primary key for entityId=%s (path=%s); skipping delete audit entry',
      entityId,
      nestedOp.path,
    );
    await reportUnresolvedEntityId(nestedOp.relatedModel, entityId, pkFields, onUnresolvedDeleteEntityId);
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
