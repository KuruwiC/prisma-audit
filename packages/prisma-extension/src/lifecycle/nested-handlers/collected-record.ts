/**
 * Collected Nested Record type
 *
 * Represents a nested record that has been collected and pre-processed
 * (action resolved, beforeState retrieved) but not yet enriched or built into audit logs.
 * Used as the intermediate representation between the collect phase and the
 * batch enrich+build phase of the nested audit log pipeline.
 */

import type { PrismaAction } from '../../types.js';

export interface CollectedNestedRecord {
  /** The entity data (after state for create/update, minimal record for delete) */
  entity: Record<string, unknown>;
  /** Resolved action (create, update, delete) — 'connect' records are already filtered out */
  action: PrismaAction;
  /** Before state for update/delete, null for create */
  beforeState: Record<string, unknown> | null;
  /** Related model name (e.g., 'Post', 'Comment') */
  relatedModel: string;
}
