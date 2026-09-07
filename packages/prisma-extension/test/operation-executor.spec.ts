/**
 * Tests for phase-aware error dispatch in executeAuditedOperation.
 *
 * Verifies that pipeline errors (diff-generation phase) are dispatched
 * to onPipelineError, while write errors are handled separately.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCallerMutation } from '../src/extension.js';
import { executeAuditedOperation } from '../src/lifecycle/operation-handlers/operation-executor.js';

const createMockOperation = () => ({
  model: 'User',
  action: 'update' as const,
  args: { where: { id: '1' }, data: { name: 'Updated' } },
});

const createMockContext = () => ({
  actor: { category: 'system', type: 'User', id: 'user-1' },
});

const createMockClient = () => ({
  User: {
    update: vi.fn().mockResolvedValue({ id: '1', name: 'Updated' }),
  },
});

describe('executeAuditedOperation phase-aware error dispatch', () => {
  it('should call onPipelineError when pipeline stage throws', async () => {
    const pipelineError = new Error('diff calculation failed');
    const onPipelineError = vi.fn();
    const failingStage = vi.fn().mockRejectedValue(pipelineError);

    const deps = {
      lifecycleStages: [failingStage],
      writeAuditLogs: vi.fn(),
      basePrisma: {} as never,
      onPipelineError,
    };

    await expect(
      executeAuditedOperation(createMockOperation(), createMockContext() as never, createMockClient() as never, deps),
    ).rejects.toThrow('diff calculation failed');

    expect(onPipelineError).toHaveBeenCalledTimes(1);
    expect(onPipelineError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('diff calculation failed') }),
    );
  });

  it('should NOT call onPipelineError when writeAuditLogs throws', async () => {
    const writeError = new Error('DB write failed');
    const onPipelineError = vi.fn();
    const successStage = vi.fn().mockResolvedValue({
      operation: createMockOperation(),
      auditContext: createMockContext(),
      result: { id: '1' },
      logs: [],
    });

    const deps = {
      lifecycleStages: [successStage],
      writeAuditLogs: vi.fn().mockRejectedValue(writeError),
      basePrisma: {} as never,
      onPipelineError,
    };

    await expect(
      executeAuditedOperation(createMockOperation(), createMockContext() as never, createMockClient() as never, deps),
    ).rejects.toThrow('DB write failed');

    expect(onPipelineError).not.toHaveBeenCalled();
  });

  it('should NOT call onPipelineError on success', async () => {
    const onPipelineError = vi.fn();
    const successStage = vi.fn().mockResolvedValue({
      operation: createMockOperation(),
      auditContext: createMockContext(),
      result: { id: '1' },
      logs: [],
    });

    const deps = {
      lifecycleStages: [successStage],
      writeAuditLogs: vi.fn(),
      basePrisma: {} as never,
      onPipelineError,
    };

    await executeAuditedOperation(
      createMockOperation(),
      createMockContext() as never,
      createMockClient() as never,
      deps,
    );

    expect(onPipelineError).not.toHaveBeenCalled();
  });

  it('should wrap pipeline errors with descriptive message', async () => {
    const pipelineError = new Error('diff calculation failed');
    const failingStage = vi.fn().mockRejectedValue(pipelineError);

    const deps = {
      lifecycleStages: [failingStage],
      writeAuditLogs: vi.fn(),
      basePrisma: {} as never,
    };

    await expect(
      executeAuditedOperation(createMockOperation(), createMockContext() as never, createMockClient() as never, deps),
    ).rejects.toThrow(
      '[@prisma-audit] Audited operation failed for model "User" and action "update": diff calculation failed',
    );
  });

  it('should work without onPipelineError (backward compatible)', async () => {
    const pipelineError = new Error('stage failed');
    const failingStage = vi.fn().mockRejectedValue(pipelineError);

    const deps = {
      lifecycleStages: [failingStage],
      writeAuditLogs: vi.fn(),
      basePrisma: {} as never,
      // no onPipelineError
    };

    await expect(
      executeAuditedOperation(createMockOperation(), createMockContext() as never, createMockClient() as never, deps),
    ).rejects.toThrow('stage failed');
  });

  it('should propagate a caller-mutation error untouched, without calling onPipelineError', async () => {
    // Simulates the real execute-operation stage: it runs the caller's own mutation
    // through `runCallerMutation`, tagging whatever it throws (e.g. a unique constraint
    // violation) as the caller's own failure rather than an audit-stage failure.
    const callerError = new Error('Unique constraint failed on the fields: (`email`)');
    const failingStage = vi.fn().mockImplementation(async () => {
      return runCallerMutation(async () => {
        throw callerError;
      });
    });
    const onPipelineError = vi.fn();

    const deps = {
      lifecycleStages: [failingStage],
      writeAuditLogs: vi.fn(),
      basePrisma: {} as never,
      onPipelineError,
    };

    const resultPromise = executeAuditedOperation(
      createMockOperation(),
      createMockContext() as never,
      createMockClient() as never,
      deps,
    );

    // Not wrapped, not a different object, message unchanged — the exact error Prisma threw.
    await expect(resultPromise).rejects.toBe(callerError);
    expect(onPipelineError).not.toHaveBeenCalled();
  });
});
