/** @kuruwic/db-audit-core - ORM-independent core library for audit logging */

export type { EntityConfigLookup } from './aggregate/entity-config-lookup.js';
export { createEntityConfigLookup } from './aggregate/entity-config-lookup.js';
export {
  batchLookup,
  defineAggregateMapping,
  defineEntity,
  foreignKey,
  lookup,
  normalizeId,
  self,
  to,
  validateAggregateMapping,
} from './aggregate/helpers.js';
export type {
  AggregateMapping,
  AggregateRoot,
  LoggableEntity,
  ResolvedId,
} from './aggregate/types.js';
export type { ComposeAmbient, ComposeConfig, EntityComposeConfig } from './compose/index.js';
export { compose } from './compose/index.js';
export type { GlobalContextEnricherConfig, SerializationConfig } from './config.types.js';
export { createAsyncLocalStorageProvider } from './context-provider.js';
export type { DispatchConfig } from './dispatch/index.js';
export { dispatch } from './dispatch/index.js';
export type { AuditLogData, AuditLogInput } from './domain/audit-log-types.js';
export type { ActorId, AggregateId, EntityId } from './domain/branded-types.js';
export {
  createActorId,
  createAggregateId,
  createEntityId,
  IdValidationError,
  unwrapId,
} from './domain/branded-types.js';
export type {
  AuditRecord,
  BeforeState,
  MutationAction,
  MutationEvent,
  MutationOrigin,
  ResolvedEvent,
  WritePlan,
} from './domain/mutation-event.js';
export type { Result, ValidationError } from './domain/smart-constructors.js';
export { createAuditLogData } from './domain/smart-constructors.js';
export type { TransactionRuntime, WriteContext, WriteExecutor, WriteFn } from './domain/write.js';
export type { ProjectionEnrichmentMeta } from './enrichment/types.js';
export type {
  AuditErrorContext,
  AuditErrorObserver,
  AuditErrorPhase,
  ErrorHandlingConfig,
  FailureSink,
  WriteFailurePolicy,
} from './failure/index.js';
export { createFailureSink } from './failure/index.js';
// Exported because the adapter package imports it across the package boundary;
// end users are not meant to call it directly.
export { getGlobalSingleton } from './global-singleton.js';
export type { PolicyConfig, WritePolicy } from './policy/index.js';
export { policy } from './policy/index.js';
export type {
  EntityResolveConfig,
  FailedResolver,
  Resolution,
  ResolveConfig,
  ResolverFailure,
} from './resolve/index.js';
export { resolve } from './resolve/index.js';
export type { AuditActor, AuditContext, AuditContextProvider } from './types.js';
export type { ErrorStrategy } from './utils/error-handler.js';
export type { RedactConfig } from './utils/redaction.js';
export type { ValueSerializer } from './utils/serialization.js';
export { UNHANDLED } from './utils/serialization.js';
