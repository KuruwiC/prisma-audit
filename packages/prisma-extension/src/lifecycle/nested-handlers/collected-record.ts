/**
 * Collected Nested Record type
 *
 * A nested record with its action resolved and its before-state retrieved, as the collectors
 * hand it over to become a mutation event.
 */

import type { AuditAction } from '../../grammar/operations.js';

export interface CollectedNestedRecord {
  /** The entity data (after state for create/update, minimal record for delete) */
  entity: Record<string, unknown>;
  /** Resolved action (create, update, delete) — 'connect' records are already filtered out */
  action: AuditAction;
  /** Before state for update/delete, null for create */
  beforeState: Record<string, unknown> | null;
  /** Related model name (e.g., 'Post', 'Comment') */
  relatedModel: string;
}
