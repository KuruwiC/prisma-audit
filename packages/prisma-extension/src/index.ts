/**
 * @kuruwic/prisma-audit - Prisma Extension for Audit Logging
 *
 * Framework-agnostic audit logging solution with aggregate root support,
 * enrichment pipeline, branded types, and redaction utilities.
 *
 * @packageDocumentation
 */

// ============================================================================
// Re-export selected @kuruwic/prisma-audit-core functionality
// ============================================================================

export type {
  ActorId,
  AggregateId,
  AggregateMapping,
  AuditContext,
  AuditContextProvider,
  EntityId,
  Result,
  ValidationError,
} from '@kuruwic/prisma-audit-core';

export {
  createActorId,
  createAggregateId,
  createAsyncLocalStorageProvider,
  createAuditLogData,
  createEntityId,
  defineAggregateMapping,
  defineEntity,
  foreignKey,
  IdValidationError,
  isActorId,
  isAggregateId,
  isEntityId,
  resolveId,
  to,
  unwrapId,
} from '@kuruwic/prisma-audit-core';

// ============================================================================
// Extension-specific exports
// ============================================================================
export type { PrismaClientWithAudit } from './client-factory.js';
export { createAuditClient, defineConfig } from './client-factory.js';
export type { PrismaModelNames, PrismaModelType } from './prisma-types.js';
export { flushAllPendingWrites, getPendingWriteCount } from './runtime/pending-writes.js';
export type {
  AuditErrorContext,
  AuditErrorObserver,
  AuditErrorPhase,
  AuditLogData,
  AuditLogInput,
  AuditLogWriter,
  ErrorHandlingConfig,
  PerformanceConfig,
  PrismaAuditExtensionOptions,
  WriteFailurePolicy,
} from './types.js';

export type { NormalizedSchema, SharedChangeSchema } from './utils/normalized-writer.js';
export { createEntityNormalizedWriter, createSharedChangeWriter } from './utils/normalized-writer.js';
