/**
 * Nested Handlers Module
 *
 * Handlers for nested write operations in audit logging.
 */

export type { NestedAuditLogBuilderDependencies } from './audit-log-builder.js';
export { buildNestedAuditLogs } from './audit-log-builder.js';

export type {
  DeleteHandlerDependencies,
  NestedOperationInfo,
  NestedPreFetchResults,
} from './delete-handler.js';
export { handleNestedDelete } from './delete-handler.js';

export type { NestedRecordsInfo, RecordProcessorDependencies } from './record-processor.js';
export { processNestedRecord, shouldSkipNestedRecord } from './record-processor.js';

export type {
  GetNestedOperationConfig,
  NestedOperationConfig,
  ResolvedState,
} from './state-resolver.js';
export { resolveNestedOperationState } from './state-resolver.js';
