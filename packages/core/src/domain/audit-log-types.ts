/**
 * Audit Log Type Definitions
 *
 * Core audit log data structures that are framework-independent.
 */

import type { ActorId, AggregateId, EntityId } from './branded-types.js';

/** Audit log data structure with Branded IDs (validated domain model with type-safe identifiers) */
export interface AuditLogData {
  actorCategory: string;
  actorType: string;
  actorId: ActorId;
  actorContext: unknown;
  entityCategory: string;
  entityType: string;
  entityId: EntityId;
  entityContext: unknown;
  aggregateCategory: string;
  aggregateType: string;
  aggregateId: AggregateId;
  aggregateContext: unknown;
  action: string;
  before: unknown;
  after: unknown;
  changes: unknown;
  requestContext: unknown;
  createdAt: Date;
}

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
  action: string;
  before: unknown;
  after: unknown;
  changes: unknown;
  requestContext: unknown;
  createdAt: Date;
}
