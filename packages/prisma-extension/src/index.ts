/**
 * @prisma-audit/prisma - Prisma Extension for Audit Logging
 *
 * Framework-agnostic audit logging solution with aggregate root support,
 * enrichment pipeline, branded types, and redaction utilities.
 *
 * @packageDocumentation
 */
export type {
  ActorEnricher,
  ActorId,
  AggregateConfigService,
  AggregateId,
  AggregateIdResolver,
  AggregateMapping,
  AggregateResolutionContext,
  AggregateRoot,
  ContextEnricherConfig,
  EnrichmentErrorStrategy,
  EntitiesEnricher,
  EntityId,
  ErrorHandler,
  ErrorStrategy,
  GlobalContextEnricherConfig,
  LoggableEntity,
  RedactConfig,
  Redactor,
  ResolvedId,
  Result,
  TraceId,
  ValidationError,
} from '@kuruwic/prisma-audit-core';
export {
  createActorId,
  createAggregateConfig,
  createAggregateId,
  createAuditLogData,
  createEntityId,
  createErrorHandler,
  createRedactor,
  createTraceId,
  DEFAULT_ENTITY_CATEGORY,
  defineAggregateMapping,
  defineEntity,
  failure,
  foreignKey,
  getDefaultSensitiveFields,
  IdValidationError,
  isActorId,
  isAggregateId,
  isEntityId,
  isSensitiveField,
  isTraceId,
  normalizeId,
  redactSensitiveData,
  resolveAggregateId,
  resolveAllAggregateRoots,
  resolveId,
  self,
  success,
  to,
  unwrapId,
  validateAggregateMapping,
  withErrorHandling,
  withErrorHandlingSync,
} from '@kuruwic/prisma-audit-core';
export type { PrismaClientWithAudit } from './client-factory.js';
export { createAuditClient, defineConfig } from './client-factory.js';
export type { GetNestedOperationConfigDependencies } from './config/index.js';
export { getNestedOperationConfig, validateFieldConflicts } from './config/index.js';
export { createAuditLogExtension } from './extension.js';
export type {
  BatchEnrichedContext,
  BatchFinalContext,
  BatchInitialContext,
  EnrichedContext,
  ExecutedContext,
  FinalContext,
  InitialContext,
  LifecycleStage,
  NestedPreFetchResults,
  PreparedContext,
} from './lifecycle/index.js';
export { runLifecyclePipeline } from './lifecycle/index.js';
export type {
  AuditLogData,
  AuditLogInput,
  AuditLogWriter,
  DiffingConfig,
  EnrichmentResolver,
  HooksConfig,
  OperationContext,
  PerformanceConfig,
  PrismaAction,
  PrismaAuditExtensionOptions,
  SecurityConfig,
} from './types.js';

export type { IdFieldInfo, IdGenerator } from './utils/id-generator.js';
export { ensureIds, getIdFieldInfo, getIdGenerator, ID_GENERATORS } from './utils/id-generator.js';

export {
  extractDeleteOperationEntityId,
  getPrisma,
  injectDeepInclude,
  isAuditableAction,
  isBatchOperation,
  isSingleOperation,
  isWriteOperation,
  requiresBeforeState,
  shouldAuditModel,
  uncapitalizeFirst,
} from './utils/index.js';

export type { NormalizedSchema, SharedChangeSchema } from './utils/normalized-writer.js';
export { createEntityNormalizedWriter, createSharedChangeWriter } from './utils/normalized-writer.js';
