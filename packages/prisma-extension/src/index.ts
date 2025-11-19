/**
 * @prisma-audit/prisma - Prisma Extension for Audit Logging
 *
 * Framework-agnostic audit logging solution with aggregate root support,
 * enrichment pipeline, branded types, and redaction utilities.
 *
 * @packageDocumentation
 */

// ============================================================================
// Re-export all @kuruwic/prisma-audit-core functionality
// ============================================================================

export type {
  // Config Types
  ActorEnricher,
  // Enrichment Types
  ActorEnricherConfig,
  // Domain Types
  ActorId,
  // Aggregate Types
  AggregateConfigService,
  AggregateId,
  AggregateIdResolver,
  AggregateMapping,
  AggregateResolutionContext,
  AggregateRoot,
  AnyBrandedId,
  // Constants
  AuditAction,
  AuditActor,
  AuditContext,
  AuditContextProvider,
  // Error Handler Types
  AuditErrorContext,
  AuditErrorHandler,
  AuditErrorPhase,
  AuditLogData as CoreAuditLogData,
  AuditLogInput as CoreAuditLogInput,
  AuditLogOptions,
  CapitalizedModelNames,
  ContextEnricherConfig,
  // Interfaces
  CreateArgs,
  DbClient,
  // Write Strategies
  DbClientManager,
  DefaultWriteFn,
  DeferredResult,
  DefineEntityOptions,
  DeleteArgs,
  // Diff Calculator
  DiffCalculator,
  DiffResult,
  EnricherConfig,
  EnricherErrorStrategy,
  EnrichmentErrorStrategy,
  EntitiesEnricher,
  EntityEnricherConfig,
  EntityId,
  ErrorHandler,
  ErrorStrategy,
  FieldChange,
  FieldMetadata,
  FindArgs,
  GetModelDelegate,
  GetModelType,
  GetOperationConfig,
  GlobalContextEnricherConfig,
  // ID Generator (from core)
  IdFieldInfo as CoreIdFieldInfo,
  IdGenerator as CoreIdGenerator,
  IdTransformer,
  ImmediateResult,
  LoggableEntity,
  ModelDelegate,
  NestedOperationConfig,
  // Nested Operations
  NestedOperationInfo,
  NestedOperationKeyword,
  // PreFetch Types
  NestedPreFetchResult,
  NestedRecordInfo,
  OperationPreFetchConfig,
  ParsedWhereClause,
  PreFetchedRecord,
  PreFetchPath,
  PreFetchResult,
  PreFetchResults,
  PrismaModelNames,
  // Redaction Types
  RedactConfig,
  RedactedFieldInfo,
  RedactMaskFn,
  Redactor,
  RelationField,
  ResolvedId,
  ResolvedNestedState,
  Result,
  SchemaMetadata,
  SkippedResult,
  TraceId,
  Transaction,
  TypedAggregateMapping,
  UniqueConstraint,
  UpdateArgs,
  ValidationError,
  WriteExecutor,
  WriteFn,
  WriteResult,
  WriteStrategy,
  WriteStrategyConfig,
} from '@kuruwic/prisma-audit-core';

export {
  // Constants
  AUDIT_ACTION,
  // State Resolution
  applyRelationConfig,
  // Enrichment Functions
  batchEnrichAggregateContexts,
  batchEnrichEntityContexts,
  // PreFetch Functions
  buildPreFetchQuery,
  // Serialization
  convertDatesToISOStrings,
  // Utils - Debug
  coreLog,
  // Domain Functions
  createActorId,
  // Aggregate Functions
  createAggregateConfig,
  createAggregateId,
  // Context Provider
  createAsyncLocalStorageProvider,
  createAuditLogData,
  // Write Strategies
  createBaseClientWriteFn,
  createDefaultWriteFn,
  // Utils - Diff Calculator
  createDiffCalculator,
  createEmptyPreFetchResults,
  createEntityId,
  // Error Handler
  createErrorHandler,
  // Redaction
  createRedactor,
  createTraceId,
  createWriteStrategySelector,
  DEFAULT_ENTITY_CATEGORY,
  DEFAULTS,
  defaultAuditErrorHandler,
  defineAggregateMapping,
  defineEntity,
  // Nested Operations
  detectNestedDeletes,
  detectNestedOperations,
  detectNestedUpdates,
  detectNestedUpserts,
  enrichActorContext,
  // Utils - ID Generator (from core)
  ensureIds as coreEnsureIds,
  executeBatchEnricherSafely,
  executeEnricherSafely,
  executePreFetch,
  extractNestedRecords,
  failure,
  filterOperationsToPreFetch,
  foreignKey,
  getDefaultSensitiveFields,
  getIdFieldInfo as coreGetIdFieldInfo,
  getIdGenerator as coreGetIdGenerator,
  getPreFetchedRecord,
  handleAuditError,
  hasOrNot,
  hasPreFetchedRecord,
  ID_GENERATORS as CORE_ID_GENERATORS,
  IdValidationError,
  isActorId,
  isAggregateConfigService,
  isAggregateId,
  isEntityId,
  isRelationField,
  isSensitiveField,
  isTraceId,
  matchesUniqueConstraint,
  NESTED_OPERATION_KEYWORDS,
  nestedLog,
  normalizeId,
  parseWhereClause,
  preFetchBeforeState,
  preFetchLog,
  redactSensitiveData,
  refetchNestedRecords,
  // Relation Configuration
  removeRelations,
  resolveAggregateId,
  resolveAllAggregateRoots,
  resolveBeforeAndAfterStates,
  resolveConnectOrCreateState,
  resolveCreateState,
  resolveDeleteState,
  resolveId,
  resolveIncludeRelationsConfig,
  resolveUpdateState,
  resolveUpsertState,
  SUPPORTED_OPERATIONS,
  self,
  sortByPathDepth,
  success,
  to,
  unwrapId,
  validateAggregateMapping,
  withErrorHandling,
  withErrorHandlingSync,
  writeDeferredInTransaction,
  writeFireAndForget,
  writeSynchronously,
} from '@kuruwic/prisma-audit-core';

// ============================================================================
// Extension-specific exports
// ============================================================================
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
