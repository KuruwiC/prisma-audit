/**
 * Lifecycle Pipeline Public API
 *
 * Type-safe context transformation pipeline for audit logging operations.
 * Supports single operations (create, update, delete, upsert) and batch operations
 * (createMany, updateMany, deleteMany).
 *
 * @module lifecycle
 */

export type {
  DeleteHandlerDependencies,
  GetNestedOperationConfig,
  NestedAuditLogBuilderDependencies,
  NestedOperationConfig,
  NestedOperationInfo,
  NestedPreFetchResults,
  NestedRecordsInfo,
  RecordProcessorDependencies,
  ResolvedState,
} from './nested-handlers/index.js';
export {
  buildNestedAuditLogs,
  handleNestedDelete,
  processNestedRecord,
  resolveNestedOperationState,
  shouldSkipNestedRecord,
} from './nested-handlers/index.js';
export type {
  OperationExecutorDependencies,
  TopLevelHandlerDependencies,
} from './operation-handlers/index.js';
export {
  executeAuditedOperation,
  handleTopLevelOperation,
  refetchForDateHydration,
} from './operation-handlers/index.js';
export { runLifecyclePipeline } from './pipeline.js';
export {
  categorizeRelationType,
  type DetectNestedOperationsFn,
  findDMMFField,
  type GetOperationConfig,
  type NestedOperation as CoordinatorNestedOperation,
  type PreFetchCoordinatorDependencies,
  preFetchNestedRecordsBeforeOperation,
  resolveParentModelFromPath,
} from './pre-fetch/index.js';
export type { TransactionProxyDependencies } from './transaction-proxy.js';
export {
  createTransactionProxy,
  createTransactionProxyHandler,
  createWrappedTransactionCallback,
} from './transaction-proxy.js';
export type {
  BatchEnrichedContext,
  BatchFinalContext,
  BatchInitialContext,
  EnrichedContext,
  ExecutedContext,
  FinalContext,
  InitialContext,
  LifecycleStage,
  PreparedContext,
} from './types.js';
