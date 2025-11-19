/** @kuruwic/prisma-audit-core - Framework-agnostic core library for audit logging */

// Aggregate Config
export type { AggregateConfigService } from './aggregate/config.js';
export { createAggregateConfig, isAggregateConfigService } from './aggregate/config.js';
// Aggregate Helpers
export type { DefineEntityOptions, IdTransformer } from './aggregate/helpers.js';
export {
  defineAggregateMapping,
  defineEntity,
  foreignKey,
  normalizeId,
  resolveAggregateId,
  resolveAllAggregateRoots,
  resolveId,
  self,
  to,
  validateAggregateMapping,
} from './aggregate/helpers.js';
// Aggregate Types
export type {
  AggregateIdResolver,
  AggregateMapping,
  AggregateResolutionContext,
  AggregateRoot,
  CapitalizedModelNames,
  GetModelDelegate,
  GetModelType,
  LoggableEntity,
  PrismaModelNames,
  ResolvedId,
  TypedAggregateMapping,
} from './aggregate/types.js';
export { DEFAULT_ENTITY_CATEGORY } from './aggregate/types.js';
// Config Types
export type {
  ActorEnricher,
  AuditLogOptions,
  ContextEnricherConfig,
  EnrichmentErrorStrategy,
  EntitiesEnricher,
  GlobalContextEnricherConfig,
  NestedOperationConfig,
} from './config.types.js';
// Constants
export type { AuditAction } from './constants.js';
export { AUDIT_ACTION, DEFAULTS, SUPPORTED_OPERATIONS } from './constants.js';
// Context Provider
export { createAsyncLocalStorageProvider } from './context-provider.js';
// Domain - Audit Log Types
export type { AuditLogData, AuditLogInput } from './domain/audit-log-types.js';
// Domain - Branded Types
export type {
  ActorId,
  AggregateId,
  AnyBrandedId,
  EntityId,
  TraceId,
} from './domain/branded-types.js';
export {
  createActorId,
  createAggregateId,
  createEntityId,
  createTraceId,
  IdValidationError,
  isActorId,
  isAggregateId,
  isEntityId,
  isTraceId,
  unwrapId,
} from './domain/branded-types.js';
// Domain - Smart Constructors
export type { Result, ValidationError } from './domain/smart-constructors.js';
export { createAuditLogData, failure, success } from './domain/smart-constructors.js';
// Enrichment - Functions
export { enrichActorContext } from './enrichment/actor.js';
export { batchEnrichAggregateContexts, batchEnrichEntityContexts } from './enrichment/batch.js';
export { executeBatchEnricherSafely, executeEnricherSafely } from './enrichment/executor.js';
// Enrichment - Types
export type {
  ActorEnricherConfig,
  EnricherConfig,
  EnricherErrorStrategy,
  EntityEnricherConfig,
} from './enrichment/types.js';
// Interfaces
export type {
  CreateArgs,
  DbClient,
  DeleteArgs,
  FieldMetadata,
  FindArgs,
  ModelDelegate,
  RelationField,
  SchemaMetadata,
  Transaction,
  UniqueConstraint,
  UpdateArgs,
} from './interfaces/index.js';
// State Resolution
export { applyRelationConfig } from './state-resolution/apply-relation-config.js';
export { resolveBeforeAndAfterStates } from './state-resolution/index.js';
export type {
  NestedPreFetchResult,
  ResolvedNestedState,
} from './state-resolution/nested-state-resolver.js';
export {
  resolveConnectOrCreateState,
  resolveCreateState,
  resolveDeleteState,
  resolveUpdateState,
  resolveUpsertState,
} from './state-resolution/nested-state-resolver.js';
export type {
  GetOperationConfig,
  OperationPreFetchConfig,
} from './state-resolution/pre-fetch-coordinator.js';
export {
  filterOperationsToPreFetch,
  sortByPathDepth,
} from './state-resolution/pre-fetch-coordinator.js';
// Types - PreFetch
export type { PreFetchedRecord, PreFetchPath, PreFetchResults } from './types/pre-fetch.js';
export {
  createEmptyPreFetchResults,
  getPreFetchedRecord,
  hasPreFetchedRecord,
} from './types/pre-fetch.js';
// Types
export type { AuditActor, AuditContext, AuditContextProvider } from './types.js';
// Utils - Debug
export { coreLog, nestedLog, preFetchLog } from './utils/debug.js';
// Utils - Diff Calculator
export type { DiffCalculator, DiffResult, FieldChange } from './utils/diff-calculator.js';
export { createDiffCalculator } from './utils/diff-calculator.js';
// Utils - Error Handler
export type {
  AuditErrorContext,
  AuditErrorHandler,
  AuditErrorPhase,
  ErrorHandler,
  ErrorStrategy,
} from './utils/error-handler.js';
export {
  createErrorHandler,
  defaultAuditErrorHandler,
  handleAuditError,
  withErrorHandling,
  withErrorHandlingSync,
} from './utils/error-handler.js';
// Utils - ID Generator
export type { IdFieldInfo, IdGenerator } from './utils/id-generator.js';
export { ensureIds, getIdFieldInfo, getIdGenerator, ID_GENERATORS } from './utils/id-generator.js';
// Utils - Nested Operations
export type {
  NestedOperationInfo,
  NestedOperationKeyword,
  NestedRecordInfo,
} from './utils/nested-operations.js';
export {
  detectNestedDeletes,
  detectNestedOperations,
  detectNestedUpdates,
  detectNestedUpserts,
  extractNestedRecords,
  isRelationField,
  NESTED_OPERATION_KEYWORDS,
  refetchNestedRecords,
} from './utils/nested-operations.js';
// Utils - Pre-fetch
export type { ParsedWhereClause, PreFetchResult } from './utils/pre-fetch.js';
export {
  buildPreFetchQuery,
  executePreFetch,
  hasOrNot,
  matchesUniqueConstraint,
  parseWhereClause,
  preFetchBeforeState,
} from './utils/pre-fetch.js';
// Utils - Redaction
export type { RedactConfig, RedactedFieldInfo, RedactMaskFn, Redactor } from './utils/redaction.js';
export {
  createRedactor,
  getDefaultSensitiveFields,
  isSensitiveField,
  redactSensitiveData,
} from './utils/redaction.js';
// Utils - Relation Configuration
export { removeRelations } from './utils/remove-relations.js';
export { resolveIncludeRelationsConfig } from './utils/resolve-include-relations-config.js';
// Utils - Serialization
export { convertDatesToISOStrings } from './utils/serialization.js';
// Write Strategies - Functions
export {
  createBaseClientWriteFn,
  createDefaultWriteFn,
  createWriteStrategySelector,
  writeDeferredInTransaction,
  writeFireAndForget,
  writeSynchronously,
} from './write-strategies/index.js';
// Write Strategies - Interfaces
export type {
  DbClientManager,
  DefaultWriteFn,
  WriteExecutor,
} from './write-strategies/interfaces.js';
// Write Strategies - Types
export type {
  DeferredResult,
  ImmediateResult,
  SkippedResult,
  WriteFn,
  WriteResult,
  WriteStrategy,
  WriteStrategyConfig,
} from './write-strategies/types.js';
