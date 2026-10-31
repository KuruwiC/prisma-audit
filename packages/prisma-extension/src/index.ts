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
} from '@kuruwic/db-audit-core';

export {
  AuditContextMissingError,
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
export type { PrismaModelType } from './prisma-types.js';
export { flushAllPendingWrites, getPendingWriteCount } from './runtime/pending-writes.js';
export type { AuditSchema } from './schema/audit-schema.js';
export type {
  AuditErrorContext,
  AuditErrorObserver,
  AuditErrorPhase,
  AuditLogData,
  AuditLogInput,
  AuditLogWriter,
  PrismaAuditExtensionOptions,
  WriteConfig,
} from './types.js';

export type { NormalizedSchema, SharedChangeSchema } from './utils/normalized-writer.js';
export { createEntityNormalizedWriter, createSharedChangeWriter } from './utils/normalized-writer.js';
