/**
 * Collected Nested Record type
 *
 * A nested record with its action resolved and its before-state retrieved, as the collectors
 * hand it over to become a mutation event.
 */

import type { BeforeState, MutationAction } from '@kuruwic/db-audit-core';

export interface CollectedNestedRecord {
  /** The entity data (after state for create/update, minimal record for delete) */
  entity: Record<string, unknown>;
  /** Resolved action (create, update, delete); rows that are not audited are already filtered out */
  action: MutationAction;
  /** Before state as pre-fetched for update/delete, none for create */
  beforeState: BeforeState;
  /** Related model name (e.g., 'Post', 'Comment') */
  relatedModel: string;
}
