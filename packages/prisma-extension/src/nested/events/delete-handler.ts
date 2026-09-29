/**
 * Nested Delete Operation Handler
 *
 * Collects the rows a nested `delete` or `deleteMany` deleted. On a to-many relation these are the
 * operation's own write-set targets: the rows a `delete` names by unique WHERE, or the rows a
 * `deleteMany` filter matched when read ahead of the write. On a to-one relation, where the
 * target is the related row of each parent row, they are the rows pre-fetched at the path,
 * falling back to the entity ID in the operation data when nothing was pre-fetched.
 * The collected records become mutation events in collect-nested-events.ts.
 */

import {
  deserializeEntityId,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../../grammar/nested-operations.js';
import { AUDIT_ACTION } from '../../grammar/operations.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { nestedLog } from '../../utils/debug.js';
import { extractDeleteOperationEntityId } from '../../utils/extension-utils.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';
import { extractEntityId } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';
import type { NestedWriteTarget } from './write-set.js';

/**
 * A nested delete skipped because its primary key could not be resolved. `entityId` is the
 * raw serialized key, or `undefined` when no identity was ever determined.
 * `pipeline/single-executor.ts` maps these fields into an `entity-id-resolution` observer context.
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
 * resolved. Awaited by every caller, so the reporter (which in practice forwards to the
 * async error-handling observer) is never lost in a short-lived runtime.
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
 * Collect the rows a to-one nested `delete` deleted, from pre-fetched results or operation data.
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
 */
export const collectToOneDeleteRecords = async (
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
      const entity = beforeState.kind === 'captured' ? beforeState.row : deserializeEntityId(entityId, pkFields);

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
      beforeState: NO_BEFORE_STATE,
      relatedModel: nestedOp.relatedModel,
    },
  ];
};

/**
 * The deleted row of a to-many delete target: its pre-fetched row, else its primary key, from the
 * locator or from the unique WHERE; null when neither holds the full primary key.
 */
const deletedEntityOf = (target: NestedWriteTarget, pkConstraint: UniqueConstraint): Record<string, unknown> | null => {
  if (target.before.kind === 'captured') {
    return target.before.row;
  }
  if (target.locator.by === 'primaryKey') {
    return target.locator.where;
  }
  return deserializeEntityId(extractEntityId(null, target.locator.where, pkConstraint), pkConstraint.fields);
};

/**
 * The rows a to-many nested `delete` or `deleteMany` deleted: the operation's own targets, each
 * with the before-state read ahead of the write (unavailable when that read failed), or its
 * primary key alone when the before-state was not requested. A `delete` target whose WHERE names
 * no primary key and whose row was not read is skipped and reported through
 * `onUnresolvedDeleteEntityId`, like an unresolved to-one delete.
 */
export const collectToManyDeleteRecords = async (
  nestedOp: NestedOperationInfo,
  targets: readonly NestedWriteTarget[],
  pkConstraint: UniqueConstraint,
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter,
): Promise<CollectedNestedRecord[]> => {
  const collected: CollectedNestedRecord[] = [];
  for (const target of targets) {
    if (target.operation !== nestedOp) {
      continue;
    }
    const entity = deletedEntityOf(target, pkConstraint);
    if (entity === null) {
      nestedLog('cannot resolve primary key of a delete target (path=%s); skipping delete audit entry', nestedOp.path);
      await reportUnresolvedEntityId(
        nestedOp.relatedModel,
        UNRESOLVED_ENTITY_ID,
        pkConstraint.fields,
        onUnresolvedDeleteEntityId,
      );
      continue;
    }
    collected.push({
      entity,
      action: AUDIT_ACTION.DELETE,
      beforeState: target.before,
      relatedModel: nestedOp.relatedModel,
    });
  }
  return collected;
};
