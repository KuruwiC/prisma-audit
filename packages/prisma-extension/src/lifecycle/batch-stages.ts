/**
 * Batch Operation Lifecycle Stages
 *
 * Defines lifecycle stages for batch operations (createMany, updateMany, deleteMany).
 * Follows the same pipeline pattern as single operations but operates on entity arrays.
 *
 * @module lifecycle/batch-stages
 */

import { collectBatchOperationEvents } from '../pipeline/collect-events.js';
import { getModelName, type StageDependencies, toAuditAction } from './stages.js';
import type { BatchFinalContext, BatchInitialContext, LifecycleStage } from './types.js';

/**
 * Creates the batch build-logs stage
 *
 * Collects one mutation event per written row, paired with its before state, and produces
 * their audit records in one pass, so the actor is enriched once and the rows are enriched
 * and resolved together (N rows, one call per enricher).
 *
 * Pipeline: BatchInitialContext → BatchFinalContext
 */
export const createBatchBuildLogsStage = (
  deps: Pick<StageDependencies, 'schemaMetadata' | 'produceRecords'>,
): LifecycleStage<BatchInitialContext, BatchFinalContext> => {
  return async (context: BatchInitialContext): Promise<BatchFinalContext> => {
    const events = collectBatchOperationEvents(
      {
        modelName: getModelName(context.operation.model),
        action: toAuditAction(context.operation.action),
        rows: context.entities,
        beforeStates: context.beforeStates,
      },
      deps.schemaMetadata,
    );

    const logs = await deps.produceRecords(events, context.auditContext);

    return { ...context, logs, result: undefined };
  };
};
