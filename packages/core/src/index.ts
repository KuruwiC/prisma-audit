/** @kuruwic/prisma-audit-core - Framework-agnostic core library for audit logging */

// Aggregate Config
export type { AggregateConfigService } from './aggregate/config.js';
export { createAggregateConfig } from './aggregate/config.js';
// Aggregate Helpers
export {
  batchResolveIds,
  defineAggregateMapping,
  defineEntity,
  foreignKey,
  normalizeId,
  resolveAggregateId,
  resolveId,
  self,
  to,
  validateAggregateMapping,
} from './aggregate/helpers.js';
// Aggregate Types
export type {
  AggregateMapping,
  AggregateRoot,
  BatchAggregateIdResolver,
  LoggableEntity,
  ResolvedId,
} from './aggregate/types.js';
// Compose
export type { ComposeAmbient, ComposeConfig, EntityComposeConfig } from './compose/index.js';
export { compose } from './compose/index.js';
// Config Types
export type { GlobalContextEnricherConfig, SerializationConfig } from './config.types.js';
// Constants
export type { AuditAction, EntityIdentityKey } from './constants.js';
export {
  AUDIT_ACTION,
  BATCH_OPERATIONS,
  BATCH_TO_SINGULAR_ACTION,
  DEFAULTS,
  SINGLE_OPERATIONS,
  SUPPORTED_OPERATIONS,
  UNRESOLVED_ENTITY_ID,
} from './constants.js';
// Context Provider
export { createAsyncLocalStorageProvider } from './context-provider.js';
// Dispatch
export type { DispatchScope } from './dispatch/index.js';
export { dispatch } from './dispatch/index.js';
// Domain - Audit Log Types
export type { AuditLogData, AuditLogInput } from './domain/audit-log-types.js';
// Domain - Branded Types
export type { ActorId, AggregateId, EntityId } from './domain/branded-types.js';
export {
  createActorId,
  createAggregateId,
  createEntityId,
  IdValidationError,
  isActorId,
  isAggregateId,
  isEntityId,
  unwrapId,
} from './domain/branded-types.js';
// Domain - Mutation Event
export type {
  AuditRecord,
  MutationAction,
  MutationEvent,
  MutationOrigin,
  ResolvedEvent,
  WritePlan,
} from './domain/mutation-event.js';
// Domain - Smart Constructors
export type { Result, ValidationError } from './domain/smart-constructors.js';
export { createAuditLogData } from './domain/smart-constructors.js';
// Enrichment - Functions
export { enrichActorContext } from './enrichment/actor.js';
export {
  batchEnrichEntityContexts,
  batchEnrichProjectionContexts,
  batchEnrichRootAggregateContexts,
} from './enrichment/batch.js';
// Enrichment - Types
export type { ProjectionEnrichmentMeta } from './enrichment/types.js';
// Global Singleton
//
// Exported because @kuruwic/prisma-audit imports it across the package boundary;
// end users are not meant to call it directly.
export { getGlobalSingleton } from './global-singleton.js';
// Policy
export type { PolicyConfig, WritePolicy } from './policy/index.js';
export { policy } from './policy/index.js';
// Resolve
export type { EntityResolveConfig, ResolveConfig } from './resolve/index.js';
// Runtime Context (library-owned infrastructure state)
//
// Exported because @kuruwic/prisma-audit imports it across the package boundary;
// end users are not meant to call it directly.
export { getRuntimeContext, runWithRuntimeContext } from './runtime-context.js';
// State Resolution
export { applyRelationConfig } from './state-resolution/apply-relation-config.js';
export { resolveBeforeAndAfterStates } from './state-resolution/index.js';
// Types
export type { AuditActor, AuditContext, AuditContextProvider } from './types.js';
// Utils - Debug
export { coreLog, nestedLog, preFetchLog } from './utils/debug.js';
// Utils - Diff Calculator
export { createDiffCalculator } from './utils/diff-calculator.js';
// Utils - Error Handler
export type { ErrorHandler, ErrorStrategy } from './utils/error-handler.js';
export { createErrorHandler } from './utils/error-handler.js';
// Utils - Redaction
export type { RedactConfig } from './utils/redaction.js';
export { redactSensitiveData } from './utils/redaction.js';
// Utils - Serialization
export type { ValueSerializer } from './utils/serialization.js';
export { serializeForAuditJson, UNHANDLED } from './utils/serialization.js';
// Write Strategies
export type {
  WriteExecutor,
  WriteFn,
  WriteResult,
  WriteStrategy,
  WriteStrategyConfig,
} from './write-strategies/index.js';
export { createWriteStrategySelector, flushPendingWrites, getPendingWriteCount } from './write-strategies/index.js';
