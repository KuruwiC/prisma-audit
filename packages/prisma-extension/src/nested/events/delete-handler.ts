/**
 * Nested Delete Operation Handler
 *
 * Collects the rows a nested `delete` or `deleteMany` deleted. On a to-many relation these are the
 * operation's own write-set targets: the rows a `delete` names by unique WHERE (a row the same
 * write linked to the parent first carries the before state the link read found), or the rows a
 * `deleteMany` filter matched when read ahead of the write. On a to-one relation, where the
 * target is the related row of the parent row, it is the row pre-fetched under the delete's own
 * parent row, falling back to the entity ID in the operation data when nothing was pre-fetched.
 * The collected records become mutation events in collect-nested-events.ts.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import {
  deserializeEntityId,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../../grammar/nested-operations.js';
import type { ParentRowIdentity } from '../../grammar/nested-state.js';
import { AUDIT_ACTION } from '../../grammar/operations.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { nestedLog } from '../../utils/debug.js';
import { extractDeleteOperationEntityId } from '../../utils/extension-utils.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';
import { extractEntityId, preFetchedResultUnder } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';
import type { NestedWriteTarget } from './write-set.js';

/**
 * A nested delete skipped because its primary key could not be resolved. `entityId` is the
 * raw serialized key, or `undefined` when no identity was ever determined.
 * `pipeline/single-executor.ts` maps these fields into a `row-identification` observer context.
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
 * Collect the row a to-one nested `delete` deleted: the related row pre-fetched under the row
 * `parent` names (the delete's parent element, before the operation).
 *
 * Priority:
 *   1. The row pre-fetched under that parent row (has full record data), or its key columns
 *      when only those were read; none when it had no related row
 *   2. The parent row is unknown or its related row could not be read, and the path is marked
 *      unread: reported unresolved
 *   3. Nothing was pre-fetched for it: the entity ID in the operation data (minimal record only)
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
  parent: ParentRowIdentity | undefined,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  pkConstraint: UniqueConstraint,
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter,
): Promise<CollectedNestedRecord[]> => {
  nestedLog('delete operation detected, collecting targets');

  const pkFields = pkConstraint.fields;
  const preFetched = preFetchedResultUnder(nestedPreFetchResults, nestedOp.path, parent);

  if (preFetched) {
    const { before, key } = preFetched;
    const entity = before.kind === 'captured' ? before.row : key;
    if (!entity) {
      nestedLog('no related row was read under the parent row (path=%s); nothing to record', nestedOp.path);
      return [];
    }
    nestedLog('collected delete target from prefetch: path=%s', nestedOp.path);
    return [{ entity, action: AUDIT_ACTION.DELETE, beforeState: before, relatedModel: nestedOp.relatedModel }];
  }

  if (nestedPreFetchResults?.get(nestedOp.path)?.unread) {
    nestedLog('the deleted row at path=%s could not be read; skipping delete audit entry', nestedOp.path);
    await reportUnresolvedEntityId(nestedOp.relatedModel, UNRESOLVED_ENTITY_ID, pkFields, onUnresolvedDeleteEntityId);
    return [];
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

/** The row a link write at a to-many path read before the write under a unique WHERE, if any */
export type LinkedRowNamedBy = (where: Record<string, unknown>) => Record<string, unknown> | undefined;

/**
 * The before state of a to-many delete target: what its own read under the parent found, or, when
 * that found no row, the row the link read at the path found under its WHERE. A nested delete
 * removes a row linked to its parent, so a row its own read did not find there is one the write
 * linked to the parent before deleting it.
 */
const beforeStateOf = (target: NestedWriteTarget, linkedRowNamedBy: LinkedRowNamedBy | undefined): BeforeState => {
  if (target.before.kind !== 'none') {
    return target.before;
  }
  const linked = linkedRowNamedBy?.(target.locator.where);
  return linked ? { kind: 'captured', row: linked } : target.before;
};

/**
 * The deleted row of a to-many delete target: its row read before the write, else its primary
 * key, from the locator or from the unique WHERE; null when neither holds the full primary key.
 */
const deletedEntityOf = (
  target: NestedWriteTarget,
  before: BeforeState,
  pkConstraint: UniqueConstraint,
): Record<string, unknown> | null => {
  if (before.kind === 'captured') {
    return before.row;
  }
  if (target.locator.by === 'primaryKey') {
    return target.locator.where;
  }
  return deserializeEntityId(extractEntityId(null, target.locator.where, pkConstraint), pkConstraint.fields);
};

/**
 * The rows a to-many nested `delete` or `deleteMany` deleted: the operation's own targets, each
 * with the before-state read ahead of the write (unavailable when that read failed; see
 * {@link beforeStateOf} for a row the write linked to the parent first), or its primary key alone
 * when the before-state was not requested. A `delete` target whose WHERE names no primary key and
 * whose row was not read is skipped and reported through `onUnresolvedDeleteEntityId`, like an
 * unresolved to-one delete.
 *
 * @param linkedRowNamedBy - The rows the link read at the path found; undefined when the
 *   before-state of the delete is not requested
 */
export const collectToManyDeleteRecords = async (
  nestedOp: NestedOperationInfo,
  targets: readonly NestedWriteTarget[],
  pkConstraint: UniqueConstraint,
  linkedRowNamedBy: LinkedRowNamedBy | undefined,
  onUnresolvedDeleteEntityId?: UnresolvedDeleteEntityIdReporter,
): Promise<CollectedNestedRecord[]> => {
  const collected: CollectedNestedRecord[] = [];
  for (const target of targets) {
    if (target.operation !== nestedOp) {
      continue;
    }
    const before = beforeStateOf(target, linkedRowNamedBy);
    const entity = deletedEntityOf(target, before, pkConstraint);
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
    collected.push({ entity, action: AUDIT_ACTION.DELETE, beforeState: before, relatedModel: nestedOp.relatedModel });
  }
  return collected;
};
