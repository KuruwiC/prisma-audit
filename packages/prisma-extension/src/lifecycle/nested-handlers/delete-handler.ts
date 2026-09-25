/**
 * Nested Delete Operation Handler
 *
 * Collects the rows a nested `delete` deleted from the pre-fetched before states, falling back to
 * the entity ID in the operation data when nothing was pre-fetched, and the rows a nested
 * `deleteMany` deleted from the write set, where the pre-read of its filter put them.
 * The collected records become mutation events in collect-nested-events.ts.
 */

import { AUDIT_ACTION, type EntityIdentityKey, nestedLog, UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';
import {
  deserializeEntityId,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../../grammar/nested-operations.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { extractDeleteOperationEntityId } from '../../utils/extension-utils.js';
import type { CollectedNestedRecord } from './collected-record.js';
import type { NestedWriteTarget } from './write-set.js';

/**
 * A nested delete skipped because its primary key could not be resolved. `entityId` is the
 * raw serialized key, or `undefined` when no identity was ever determined.
 * extension.ts maps these fields into an `entity-id-resolution` observer context.
 */
export interface UnresolvedDeleteEntityId {
  relatedModel: string;
  entityId: string | undefined;
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
  entityId: EntityIdentityKey,
  pkFields: string[],
  onUnresolvedDeleteEntityId: UnresolvedDeleteEntityIdReporter | undefined,
): Promise<void> => {
  if (!onUnresolvedDeleteEntityId) return;

  const rawEntityId = entityId === UNRESOLVED_ENTITY_ID ? undefined : entityId;
  const renderedEntityId = rawEntityId === undefined ? 'unresolved' : `"${rawEntityId}"`;
  await onUnresolvedDeleteEntityId({
    relatedModel,
    entityId: rawEntityId,
    pkFields,
    error: new Error(
      `[@prisma-audit] Cannot resolve the primary key of a deleted ${relatedModel} record ` +
        `(entityId=${renderedEntityId}, pkFields=[${pkFields.join(', ')}]). Skipping this delete's audit log entry ` +
        'instead of recording a fabricated identity.',
    ),
  });
};

/**
 * Collect delete targets from pre-fetched results or operation data.
 *
 * Priority:
 *   1. Use pre-fetched before states (has full record data)
 *   2. Fallback: extract entity ID from nestedOp.data (minimal record only)
 *
 * A delete whose primary key cannot be fully resolved (`deserializeEntityId` returns
 * `null` for an unresolved identity or a malformed composite key), or whose operation data
 * yields no entityId at all, is skipped rather than recorded with a partial or empty
 * identity — an idResolver reading fields off a partial entity could produce a plausible but
 * fabricated id — and reported through `onUnresolvedDeleteEntityId` when provided.
 *
 * @param pkConstraint - The deleted model's primary key. The fallback reads the constraint's
 *   declared name as well as its fields, because a named composite key wraps the WHERE clause
 *   under that name.
 * @returns Collected records, ready to become mutation events
 */
export const collectDeleteRecords = async (
  nestedOp: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  pkConstraint: UniqueConstraint,
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter,
): Promise<CollectedNestedRecord[]> => {
  nestedLog('delete operation detected, collecting targets');

  const pkFields = pkConstraint.fields;

  const pathMap = nestedPreFetchResults?.get(nestedOp.path);

  if (pathMap && pathMap.size > 0) {
    const collected: CollectedNestedRecord[] = [];

    for (const [entityId, preFetchResult] of pathMap) {
      const beforeState = preFetchResult.before;
      const entity = beforeState ?? deserializeEntityId(entityId, pkFields);

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
    nestedLog('could not extract entity ID from delete operation data');
    // No raw entityId exists here; report the identity as never determined so the observer
    // can tell this apart from a malformed composite key, which is reported with its raw value.
    await reportUnresolvedEntityId(nestedOp.relatedModel, UNRESOLVED_ENTITY_ID, pkFields, onUnresolvedDeleteEntityId);
    return [];
  }

  const entity = deserializeEntityId(entityId, pkFields);
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

/**
 * The rows a nested `deleteMany` deleted: those its filter matched when read ahead of the
 * operation, each with the before-state that read captured, or its primary key alone when the
 * before-state was not requested.
 */
export const collectDeleteManyRecords = (
  nestedOp: NestedOperationInfo,
  targets: readonly NestedWriteTarget[],
): CollectedNestedRecord[] =>
  targets
    .filter((target) => target.operation === nestedOp)
    .map((target) => ({
      entity: target.before ?? target.where,
      action: AUDIT_ACTION.DELETE,
      beforeState: target.before ?? null,
      relatedModel: nestedOp.relatedModel,
    }));
