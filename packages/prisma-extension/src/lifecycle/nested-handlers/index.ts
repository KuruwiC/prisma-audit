/**
 * Nested Handlers Module
 *
 * Handlers for nested write operations in audit logging.
 */

export type { NestedAuditLogBuilderDependencies } from './audit-log-builder.js';
export { buildNestedAuditLogs } from './audit-log-builder.js';

export type { CollectedNestedRecord } from './collected-record.js';

export type {
  NestedOperationInfo,
  NestedPreFetchResults,
} from './delete-handler.js';
export { collectDeleteRecords } from './delete-handler.js';

export type { NestedRecordsInfo } from './record-processor.js';
export { collectNestedRecords, shouldSkipNestedRecord } from './record-processor.js';

export type {
  GetNestedOperationConfig,
  NestedOperationConfig,
  ResolvedState,
} from './state-resolver.js';
export { resolveNestedOperationState } from './state-resolver.js';
