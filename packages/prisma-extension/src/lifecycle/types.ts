/**
 * Lifecycle Pipeline Type Definitions
 *
 * Type-safe context transformation pipeline for audit logging. Each stage adds new
 * properties while preserving type safety.
 *
 * Flow: InitialContext → PreparedContext → ExecutedContext → EnrichedContext → FinalContext
 *
 * @module lifecycle/types
 */

import type { AuditContext, PreFetchResults } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import type { AuditLogData, OperationContext } from '../types.js';

/**
 * Initial context at pipeline start
 *
 * Created when a Prisma operation is intercepted. Contains minimal information to begin
 * audit logging.
 */
export interface InitialContext {
  /** Prisma operation metadata (model, action, args) */
  operation: OperationContext;
  /** Current audit context (actor, request metadata) */
  auditContext: AuditContext;
  /** Prisma client (base or transactional) */
  clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  /** Query function to execute Prisma operation */
  query: (args: unknown) => Promise<unknown>;
}

/**
 * Prepared context after pre-fetch stage
 *
 * Includes before-state and nested pre-fetch results for calculating changes and handling
 * nested operations.
 */
export interface PreparedContext extends InitialContext {
  /** State before operation (null for create) */
  beforeState: Record<string, unknown> | null;
  /** Pre-fetched nested operation states (path → record | null) */
  nestedPreFetchResults: PreFetchResults | undefined;
}

/**
 * Executed context after query execution stage
 *
 * Includes Prisma operation result for extracting entity data and calculating after-state.
 */
export interface ExecutedContext extends PreparedContext {
  /** Result of executed Prisma operation */
  result: unknown;
}

/**
 * Enriched context after enrichment stage
 *
 * Includes enriched contextual information for actor and entity. Enrichment adds
 * human-readable or computed metadata not present in raw data.
 *
 * NOTE: aggregateContext is no longer enriched at this stage. It is now enriched
 * per aggregate root inside buildAuditLog for aggregate-aware context.
 */
export interface EnrichedContext extends ExecutedContext {
  /** Enriched actor context (role, department, email) */
  actorContext: unknown | null;
  /** Enriched entity context (title, status, authorName) */
  entityContext: unknown | null;
}

/**
 * Final context after log generation stage
 *
 * Includes generated audit log entries ready to be written to storage.
 */
export interface FinalContext extends EnrichedContext {
  /** Generated audit log entries */
  logs: ReadonlyArray<AuditLogData>;
}

// =============================================================================
// Batch Operation Contexts (Phase 5)
// =============================================================================

/**
 * Initial context for batch operations
 *
 * Created when a batch operation (createMany, updateMany, deleteMany) is intercepted.
 * Contains minimal information to begin batch audit logging.
 */
export interface BatchInitialContext {
  /** Prisma batch operation metadata (model, action, args) */
  operation: OperationContext;
  /** Current audit context (actor, request metadata) */
  auditContext: AuditContext;
  /** Prisma client (base or transactional) */
  clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  /** Query function to execute batch operation */
  query: (args: unknown) => Promise<unknown>;
  /** Entities to process (with IDs for createMany, fetched for updateMany/deleteMany) */
  entities: ReadonlyArray<Record<string, unknown>>;
  /** Before states for each entity (updateMany/deleteMany only) */
  beforeStates?: ReadonlyArray<Record<string, unknown> | null>;
}

/**
 * Enriched context for batch operations after enrichment stage
 *
 * Includes enriched contextual information for actor and all entities. Enrichment is
 * performed in batch to optimize database queries.
 *
 * NOTE: aggregateContexts is no longer enriched at this stage. It is now enriched
 * per aggregate root inside buildAuditLog for aggregate-aware context.
 */
export interface BatchEnrichedContext extends BatchInitialContext {
  /** Enriched actor context (role, department, email) */
  actorContext: unknown | null;
  /** Enriched entity contexts (parallel to entities array) */
  entityContexts: ReadonlyArray<unknown | null>;
}

/**
 * Final context for batch operations after log generation stage
 *
 * Includes generated audit log entries for all entities, ready to be written to storage.
 */
export interface BatchFinalContext extends BatchEnrichedContext {
  /** Generated audit log entries for all entities */
  logs: ReadonlyArray<AuditLogData>;
  /** Result of executed batch operation */
  result: unknown;
}

// =============================================================================
// Lifecycle Stage Type
// =============================================================================

/**
 * Type-safe lifecycle stage function
 *
 * Transforms context from one type to another, adding new properties while preserving existing ones.
 *
 * @typeParam TIn - Input context type
 * @typeParam TOut - Output context type
 */
export type LifecycleStage<TIn, TOut> = (context: TIn) => Promise<TOut>;
