/**
 * Boundary data types between an ORM adapter and the audit core
 *
 * An adapter collects one {@link MutationEvent} per written row; resolution adds the entity id,
 * aggregate roots and contexts to make a {@link ResolvedEvent}; `compose` turns resolved events
 * into {@link AuditRecord}s; `dispatch` runs that build once the operation's write has run and
 * writes the records by a {@link WritePlan}.
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

/**
 * What the adapter knows of a row before the write
 *
 * - `captured`: the row as it was read before the write
 * - `none`: nothing to carry: a create, a read the configuration does not ask for, or a read that
 *   found no row
 * - `unavailable`: the read was asked for and failed; the adapter reports the failure itself
 */
export type BeforeState =
  | { readonly kind: 'captured'; readonly row: Record<string, unknown> }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

export interface MutationEvent<TModelName extends string = string> {
  readonly model: TModelName;
  /**
   * Identifies the row within its model, in a format the adapter defines; '' when the adapter
   * could not identify the row. The core never parses it: it carries it unchanged into failure
   * reports. Not the stored `entityId`, which the idResolver produces.
   */
  readonly identity: string;
  readonly action: MutationAction;
  readonly before: BeforeState;
  /**
   * Row after the write. Resolvers and enrichers receive `after ?? before`, so a delete event may
   * carry the deleted row here as the adapter last saw it; `compose` stores no after state for a
   * delete. A delete whose before state is not `captured` may carry only what the adapter knows of
   * the row without reading it, such as its key; see `foreignKey` for how that affects resolution.
   */
  readonly after?: Record<string, unknown>;
  readonly origin: MutationOrigin;
}

export interface ResolvedEvent<TModelName extends string = string> extends MutationEvent<TModelName> {
  /** Output of the entity's idResolver, normalized with `normalizeId`. */
  readonly entityId: string;
  /**
   * Self projection (unless `self: false`) plus every `to()` root that resolved from the row after
   * the write and, for an update whose before state was captured, from the row before it.
   * Empty means no record.
   */
  readonly roots: readonly ResolvedId[];
  readonly actorContext: unknown;
  readonly entityContext: unknown;
  /** Keyed `${aggregateCategory}:${aggregateType}:${aggregateId}` of each root ({@link aggregateRootKey}). */
  readonly aggregateContexts: ReadonlyMap<string, unknown>;
}

/**
 * The key of a root's aggregate context: its category, type and id, the identity that makes two
 * roots of one row distinct
 */
export const aggregateRootKey = ({ aggregateCategory, aggregateType, aggregateId }: ResolvedId): string =>
  `${aggregateCategory}:${aggregateType}:${aggregateId}`;

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
  /**
   * The adapter was asked for the row's before state and could not read it; `before` and
   * `changes` are then null. Whether and how it is stored is the write executor's or writer's
   * choice.
   */
  readonly beforeUnavailable: boolean;
  readonly requestContext: unknown;
  readonly createdAt: Date;
}

/**
 * How and when `dispatch` writes a set of records
 *
 * - `immediate`: write immediately on the transaction's handle (the base handle outside any
 *   transaction); the caller awaits it
 * - `after-commit`: registered with the enclosing transaction; run on the base handle after commit
 * - `detached`: started on the base handle, never awaited by the caller
 */
export type WritePlan =
  | { readonly kind: 'immediate'; readonly records: readonly AuditRecord[] }
  | { readonly kind: 'after-commit'; readonly records: readonly AuditRecord[] }
  | { readonly kind: 'detached'; readonly records: readonly AuditRecord[] };
