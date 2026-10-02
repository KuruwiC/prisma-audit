import type { AuditRecord } from '@kuruwic/db-audit-core';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { AuditedOperation, OperationExecutor } from '../../src/pipeline/executor.js';
import type { RecordProducer } from '../../src/pipeline/produce-records.js';

/** Runs an executor and then the build of its records, as the audited pipeline does */
export const runWithRecords = async (
  executor: OperationExecutor,
  operation: AuditedOperation,
  scope: ExecutionScope,
  produceRecords: RecordProducer,
): Promise<{ readonly result: unknown; readonly records: AuditRecord[] }> => {
  const executed = await executor.run(operation, scope, produceRecords);
  return { result: executed.result, records: await executed.buildRecords() };
};
