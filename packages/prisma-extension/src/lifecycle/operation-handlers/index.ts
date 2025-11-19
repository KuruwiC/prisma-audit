/**
 * Operation Handlers Module
 *
 * Core handlers for top-level Prisma operations (non-nested), managing operation
 * execution and audit logging lifecycle.
 *
 * @module lifecycle/operation-handlers
 */

export { refetchForDateHydration } from './date-hydration.js';

export {
  executeAuditedOperation,
  type OperationExecutorDependencies,
} from './operation-executor.js';

export { handleTopLevelOperation, type TopLevelHandlerDependencies } from './top-level-handler.js';
