/**
 * Boundary data types between an ORM adapter and the audit core
 *
 * An adapter collects one {@link MutationEvent} per written row; resolution adds the entity id,
 * aggregate roots and contexts to make a {@link ResolvedEvent}; `compose` turns resolved events
 * into {@link AuditRecord}s; `dispatch` wraps the records in a {@link WritePlan} that the adapter
 * executes.
 */

import type { ResolvedId } from '../aggregate/types.js';
import type { ActorId, AggregateId, EntityId } from './branded-types.js';

/** Action stored in the audit row. An adapter maps its insert-or-update and multi-row keywords to one of these before it emits an event. */
export type MutationAction = 'create' | 'update' | 'delete';

export interface MutationOrigin {
  /** '' for the top-level row; nested path otherwise ('posts', 'posts.comments'). Adapters without nested grammar use ''. */
  readonly path: string;
  /** Keyword that wrote the row, in the adapter's own vocabulary ('create', or a nested or multi-row keyword). The core does not interpret it. */
  readonly op: string;
}

export interface MutationEvent<TModelName extends string = string> {
  readonly model: TModelName;
  /** Primary-key identity: the serialized primary key ('42', '["a","b"]'). Sync, schema-derived. Not AuditLog.entityId. */
  readonly identity: string;
  readonly action: MutationAction;
  /** Row before the write. Absent when not captured (create, fetchBeforeOperation: false, failed fetch). */
  readonly before?: Record<string, unknown>;
  /**
   * Row after the write. Resolvers and enrichers receive `after ?? before`, so a delete event may
   * carry the deleted row here as the adapter last saw it; `compose` stores no after state for a
   * delete.
   */
  readonly after?: Record<string, unknown>;
  readonly origin: MutationOrigin;
}

export interface ResolvedEvent<TModelName extends string = string> extends MutationEvent<TModelName> {
  /** Output of the entity's idResolver, normalized with `normalizeId`. */
  readonly entityId: string;
  /** Self projection (unless `self: false`) plus every `to()` root that resolved. Empty means no record. */
  readonly roots: readonly ResolvedId[];
  readonly actorContext: unknown;
  readonly entityContext: unknown;
  /** Keyed `${aggregateType}:${aggregateId}`. */
  readonly aggregateContexts: ReadonlyMap<string, unknown>;
}

/** One audit row, with branded identifiers. Write executors consume it as-is. */
export interface AuditRecord {
  readonly actorCategory: string;
  readonly actorType: string;
  readonly actorId: ActorId;
  readonly actorContext: unknown;
  readonly entityCategory: string;
  readonly entityType: string;
  readonly entityId: EntityId;
  readonly entityContext: unknown;
  readonly aggregateCategory: string;
  readonly aggregateType: string;
  readonly aggregateId: AggregateId;
  readonly aggregateContext: unknown;
  readonly action: MutationAction;
  readonly before: unknown;
  readonly after: unknown;
  readonly changes: unknown;
  readonly requestContext: unknown;
  readonly createdAt: Date;
}

/**
 * How and when the adapter writes a set of records
 *
 * - `immediate`: write now on the active handle; the caller awaits it
 * - `after-commit`: enqueue on the enclosing transaction scope; run on the base handle after commit
 * - `detached`: start now, never awaited by the caller
 */
export type WritePlan =
  | { readonly kind: 'immediate'; readonly records: readonly AuditRecord[] }
  | { readonly kind: 'after-commit'; readonly records: readonly AuditRecord[] }
  | { readonly kind: 'detached'; readonly records: readonly AuditRecord[] };
