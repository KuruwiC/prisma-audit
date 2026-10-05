/**
 * Collected Nested Record type
 *
 * A nested record with its action resolved and its before-state retrieved, as the collectors
 * hand it over to become a mutation event.
 */

import type { BeforeState, MutationAction } from '@kuruwic/db-audit-core';

export interface CollectedNestedRecord {
  /**
   * The entity data: the after state for create and update; for delete, the row before the write,
   * or what is known of it without a read
   */
  entity: Record<string, unknown>;
  /** Resolved action (create, update, delete); rows that are not audited are already filtered out */
  action: MutationAction;
  /** Before state as pre-fetched for update/delete, none for create */
  beforeState: BeforeState;
  /** Related model name (e.g., 'Post', 'Comment') */
  relatedModel: string;
  /**
   * For a delete, the event's after state: the row as the write left it before deleting it, where
   * the before state does not show it. That is the row holding the stored key of the parent it was
   * deleted from when a keyword listed before the delete linked it there, or what is known of a
   * row whose before state was not read. Undefined for a row deleted as it was read.
   */
  rowAsWritten?: Record<string, unknown>;
}
