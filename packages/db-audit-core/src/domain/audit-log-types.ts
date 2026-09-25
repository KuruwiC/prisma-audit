/**
 * Audit Log Type Definitions
 *
 * Core audit log data structures that are framework-independent.
 */

import type { AuditRecord, MutationAction } from './mutation-event.js';

/** Audit log data structure with Branded IDs (validated domain model with type-safe identifiers) */
export type AuditLogData = AuditRecord;

/** Input for creating AuditLogData (uses plain strings for IDs) */
export interface AuditLogInput {
  actorCategory: string;
  actorType: string;
  actorId: string;
  actorContext: unknown;
  entityCategory: string;
  entityType: string;
  entityId: string;
  entityContext: unknown;
  aggregateCategory: string;
  aggregateType: string;
  aggregateId: string;
  aggregateContext: unknown;
  action: MutationAction;
  before: unknown;
  after: unknown;
  changes: unknown;
  beforeUnavailable: boolean;
  requestContext: unknown;
  createdAt: Date;
}
