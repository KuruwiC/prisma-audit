/**
 * @kuruwic/prisma-audit - Prisma Extension for Audit Logging
 *
 * Prisma Client extension for audit logging, built on @kuruwic/db-audit-core: aggregate root
 * support, an enrichment pipeline, branded types and redaction utilities.
 *
 * @packageDocumentation
 */

// ============================================================================
// Re-export selected @kuruwic/db-audit-core functionality
// ============================================================================

export type {
  ActorId,
  AggregateId,
  AuditContext,
  AuditContextProvider,
  AuditRecord,
  EntityId,
  EntityMap,
  Result,
  ValidationError,
  WriteContext,
  WriteMode,
} from '@kuruwic/db-audit-core';

export {
  AuditAtomicityError,
  AuditContextMissingError,
  AuditIncompleteError,
  AuditReentrantWriteError,
  AuditRollbackError,
  createActorId,
  createAggregateId,
  createAsyncLocalStorageProvider,
  createAuditLogData,
  createEntityId,
  defineEntities,
  defineEntity,
  foreignKey,
  IdValidationError,
  lookup,
  to,
  unwrapId,
} from '@kuruwic/db-audit-core';

// ============================================================================
// Extension-specific exports
// ============================================================================
export type { PrismaClientWithAudit } from './client-factory.js';
export { createAuditClient, defineConfig } from './client-factory.js';
export { AuditParentWriteError, AuditUnboundWriteError } from './errors.js';
export type { PrismaModelType } from './prisma-types.js';
export { flushAllPendingWrites, getPendingWriteCount } from './runtime/pending-writes.js';
export type { AuditSchema } from './schema/audit-schema.js';
export type {
  AuditFailure,
  AuditFailurePhase,
  AuditIsolation,
  AuditLogData,
  AuditLogInput,
  AuditLogWriter,
  AuditObserver,
  AuditOutcome,
  AuditOutcomeStatus,
  PrismaAuditExtensionOptions,
  UnrecordedWrite,
  WriteConfig,
} from './types.js';

export type { NormalizedSchema, NormalizedWriter, SharedChangeSchema } from './utils/normalized-writer.js';
export { createEntityNormalizedWriter, createSharedChangeWriter } from './utils/normalized-writer.js';
