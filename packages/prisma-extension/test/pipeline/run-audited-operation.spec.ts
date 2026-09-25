/**
 * Tests for the audited-operation pipeline: the write policy decides the scope, the executor
 * runs inside it through the continuation the scope calls for, its records are dispatched into
 * a write plan and written, and each kind of failure reaches the caller and the failure sink
 * the way its origin requires.
 */

import type { AuditContext, WritePlan } from '@kuruwic/prisma-audit-core';
import {
  createActorId,
  createAggregateId,
  createAsyncLocalStorageProvider,
  createEntityId,
  runWithRuntimeContext,
} from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { FailureSink } from '../../src/failure-sink.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import {
  type AuditedOperation,
  createExecutor,
  type OperationExecutor,
  type OperationOutcome,
} from '../../src/pipeline/executor.js';
import {
  type AuditPipelineDependencies,
  type InterceptedOperation,
  runAuditedOperation,
} from '../../src/pipeline/run-audited-operation.js';
import type { AuditLogData } from '../../src/types.js';
import { isCallerMutationError, runCallerMutation } from '../../src/utils/caller-mutation-error.js';

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

const transactionClientWith = (delegates: Record<string, unknown> = {}): TransactionalPrismaClient =>
  Object.assign(Object.create(null), { name: 'transaction', ...delegates });
const transactionClient = transactionClientWith();

interface BaseClientStub extends PrismaClientWithDynamicAccess {
  readonly transactionsOpened: { count: number };
}

const createBaseClient = (
  transaction: TransactionalPrismaClient = transactionClient,
  delegates: Record<string, unknown> = {},
): BaseClientStub => {
  const transactionsOpened = { count: 0 };
  return {
    $transaction: async <T>(fn: (tx: TransactionalPrismaClient) => Promise<T>): Promise<T> => {
      transactionsOpened.count += 1;
      return fn(transaction);
    },
    $extends: () => undefined,
    transactionsOpened,
    ...delegates,
  };
};

const record: AuditLogData = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'User',
  entityId: createEntityId('u1'),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'User',
  aggregateId: createAggregateId('u1'),
  aggregateContext: null,
  action: 'update',
  before: { id: 'u1', name: 'Ann' },
  after: { id: 'u1', name: 'Anne' },
  changes: { name: { old: 'Ann', new: 'Anne' } },
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const args = { where: { id: 'u1' }, data: { name: 'Anne' } };

const interceptedOf = (
  action: InterceptedOperation['action'] = 'update',
  query: InterceptedOperation['query'] = vi.fn(),
): InterceptedOperation => ({ model: 'User', action, args, query });

const operationOf = (action: AuditedOperation['action'] = 'update'): AuditedOperation => ({
  model: 'User',
  action,
  args,
  execute: vi.fn(),
});

const outcome: OperationOutcome = { result: { id: 'u1', name: 'Anne' }, records: [record] };

const stubExecutor = (
  run: OperationExecutor['run'],
  auditFailure: OperationExecutor['auditFailure'] = (_operation, error) => error,
): OperationExecutor => ({ run: vi.fn(run), auditFailure });

const succeedingExecutor = () => stubExecutor(async () => outcome);

const createDeps = (overrides: Partial<AuditPipelineDependencies> = {}) => {
  const failureSink: FailureSink = { notify: vi.fn(async () => {}), reportWriteFailure: vi.fn(async () => {}) };
  const deps: AuditPipelineDependencies = {
    provider: createAsyncLocalStorageProvider(),
    policyConfig: { awaitWrite: true },
    modelTags: () => [],
    singleExecutor: succeedingExecutor(),
    batchExecutor: succeedingExecutor(),
    produceRecords: vi.fn(async () => [record]),
    writeAuditLogs: vi.fn(async () => {}),
    failureSink,
    ...overrides,
  };
  return deps;
};

const scopeSeenBy = (executor: OperationExecutor): ExecutionScope => {
  const call = vi.mocked(executor.run).mock.calls[0];
  if (!call) throw new Error('executor did not run');
  return call[1];
};

const planWrittenBy = (deps: AuditPipelineDependencies): WritePlan => {
  const call = vi.mocked(deps.writeAuditLogs).mock.calls[0];
  if (!call) throw new Error('nothing was written');
  return call[0];
};

describe('runAuditedOperation', () => {
  describe('policy and scope', () => {
    it('opens an implicit transaction when the policy is atomic and none is active, and writes immediately in it', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps({ policyConfig: { awaitWrite: true } });

      await runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient }, deps);

      expect(baseClient.transactionsOpened.count).toBe(1);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(transactionClient);
      expect(scope.baseHandle).toBe(baseClient);
      expect(scope.transaction?.implicit).toBe(true);
      expect(scope.atomic).toBe(true);
      expect(planWrittenBy(deps)).toEqual({ kind: 'immediate', records: [record] });
      expect(deps.writeAuditLogs).toHaveBeenCalledWith(expect.anything(), scope);
    });

    it('runs on the base client without a transaction when the policy is not atomic, and detaches the write', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps({ policyConfig: { awaitWrite: false } });

      await runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient }, deps);

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(baseClient);
      expect(scope.transaction).toBeUndefined();
      expect(scope.atomic).toBe(false);
      expect(planWrittenBy(deps).kind).toBe('detached');
    });

    it('runs on the active transaction client and writes after commit when the policy is not atomic inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps({ policyConfig: { awaitWrite: false } });
      const deferredWrites: Array<() => Promise<void>> = [];

      await runWithRuntimeContext({ transaction: { client: transactionClient, deferredWrites } }, () =>
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient }, deps),
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(transactionClient);
      expect(scope.transaction).toEqual({ deferredWrites, implicit: false });
      expect(planWrittenBy(deps).kind).toBe('after-commit');
    });

    it('consults the policy once with the model and its tags', async () => {
      const awaitWriteIf = vi.fn(() => false);
      const deps = createDeps({ policyConfig: { awaitWrite: true, awaitWriteIf }, modelTags: () => ['pii'] });

      await runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient: createBaseClient() }, deps);

      expect(awaitWriteIf).toHaveBeenCalledTimes(1);
      expect(awaitWriteIf).toHaveBeenCalledWith('User', ['pii']);
      expect(planWrittenBy(deps).kind).toBe('detached');
    });
  });

  describe('continuation', () => {
    const runningTheOperation = (action?: AuditedOperation['action']) =>
      stubExecutor(async (operation) => {
        await operation.execute(operation.args, action);
        return outcome;
      });

    it("runs the operation on the implicit transaction client's model delegate when the scope opened the transaction", async () => {
      const update = vi.fn(async () => outcome.result);
      const baseClient = createBaseClient(transactionClientWith({ user: { update } }));
      const deps = createDeps({ policyConfig: { awaitWrite: true }, singleExecutor: runningTheOperation() });
      const operation = interceptedOf();

      await runAuditedOperation({ operation, auditContext, baseClient }, deps);

      expect(update).toHaveBeenCalledWith(args);
      expect(operation.query).not.toHaveBeenCalled();
    });

    it("continues the operation through query inside the caller's own transaction", async () => {
      const update = vi.fn();
      const deps = createDeps({ policyConfig: { awaitWrite: true }, singleExecutor: runningTheOperation() });
      const operation = interceptedOf();

      await runWithRuntimeContext(
        { transaction: { client: transactionClientWith({ user: { update } }), deferredWrites: [] } },
        () => runAuditedOperation({ operation, auditContext, baseClient: createBaseClient() }, deps),
      );

      expect(operation.query).toHaveBeenCalledWith(args);
      expect(update).not.toHaveBeenCalled();
    });

    it('continues the operation through query when the policy is not atomic', async () => {
      const update = vi.fn();
      const baseClient = createBaseClient(transactionClient, { user: { update } });
      const deps = createDeps({ policyConfig: { awaitWrite: false }, singleExecutor: runningTheOperation() });
      const operation = interceptedOf();

      await runAuditedOperation({ operation, auditContext, baseClient }, deps);

      expect(operation.query).toHaveBeenCalledWith(args);
      expect(update).not.toHaveBeenCalled();
    });

    it("runs a substituted action on the scope handle's model delegate", async () => {
      const updateManyAndReturn = vi.fn(async () => []);
      const baseClient = createBaseClient(transactionClient, { user: { updateManyAndReturn } });
      const deps = createDeps({
        policyConfig: { awaitWrite: false },
        batchExecutor: runningTheOperation('updateManyAndReturn'),
      });
      const operation = interceptedOf('updateMany');

      await runAuditedOperation({ operation, auditContext, baseClient }, deps);

      expect(updateManyAndReturn).toHaveBeenCalledWith(args);
      expect(operation.query).not.toHaveBeenCalled();
    });

    it('fails when the model delegate has no such action', async () => {
      const deps = createDeps({ policyConfig: { awaitWrite: true }, singleExecutor: runningTheOperation() });

      await expect(
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient: createBaseClient() }, deps),
      ).rejects.toThrow('Model "User" or action "update" not found');
    });

    it.each([
      {
        path: 'query',
        setup: (callerError: Error) => ({
          baseClient: createBaseClient(),
          policyConfig: { awaitWrite: false },
          operation: interceptedOf(
            'update',
            vi.fn(async () => {
              throw callerError;
            }),
          ),
        }),
      },
      {
        path: 'the model delegate',
        setup: (callerError: Error) => ({
          baseClient: createBaseClient(
            transactionClientWith({
              user: {
                update: vi.fn(async () => {
                  throw callerError;
                }),
              },
            }),
          ),
          policyConfig: { awaitWrite: true },
          operation: interceptedOf(),
        }),
      },
    ])("tags the caller's own mutation error thrown through $path so it propagates raw", async ({ setup }) => {
      const callerError = new Error('Unique constraint failed on the fields: (`email`)');
      const { baseClient, policyConfig, operation } = setup(callerError);
      const deps = createDeps({ policyConfig, singleExecutor: runningTheOperation() });

      await expect(runAuditedOperation({ operation, auditContext, baseClient }, deps)).rejects.toBe(callerError);

      expect(isCallerMutationError(callerError)).toBe(true);
      expect(deps.failureSink.notify).not.toHaveBeenCalled();
      expect(deps.writeAuditLogs).not.toHaveBeenCalled();
    });
  });

  describe('executor', () => {
    it('routes a batch action to the batch executor and any other action to the single executor', async () => {
      const deps = createDeps();
      const baseClient = createBaseClient();

      await runAuditedOperation({ operation: interceptedOf('updateMany'), auditContext, baseClient }, deps);
      await runAuditedOperation({ operation: interceptedOf('upsert'), auditContext, baseClient }, deps);

      expect(deps.batchExecutor.run).toHaveBeenCalledTimes(1);
      expect(deps.batchExecutor.run).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'updateMany' }),
        expect.anything(),
        deps.produceRecords,
      );
      expect(deps.singleExecutor.run).toHaveBeenCalledTimes(1);
      expect(deps.singleExecutor.run).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'upsert' }),
        expect.anything(),
        deps.produceRecords,
      );
    });

    it('returns the executor result to the caller', async () => {
      const deps = createDeps();

      const result = await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient: createBaseClient() },
        deps,
      );

      expect(result).toBe(outcome.result);
      expect(deps.failureSink.notify).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it("propagates the caller's own mutation error untouched, without notifying the observer or writing", async () => {
      const callerError = new Error('Unique constraint failed on the fields: (`email`)');
      const deps = createDeps({
        singleExecutor: stubExecutor(() =>
          runCallerMutation(async () => {
            throw callerError;
          }),
        ),
      });

      await expect(
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient: createBaseClient() }, deps),
      ).rejects.toBe(callerError);

      expect(deps.failureSink.notify).not.toHaveBeenCalled();
      expect(deps.writeAuditLogs).not.toHaveBeenCalled();
    });

    it('reports any other executor failure as diff-generation and rethrows it the way the executor surfaces it', async () => {
      const auditError = new Error('diff calculation failed');
      const surfaced = new Error('surfaced');
      const deps = createDeps({
        singleExecutor: stubExecutor(
          async () => {
            throw auditError;
          },
          () => surfaced,
        ),
      });
      const operation = interceptedOf();

      await expect(runAuditedOperation({ operation, auditContext, baseClient: createBaseClient() }, deps)).rejects.toBe(
        surfaced,
      );

      expect(deps.failureSink.notify).toHaveBeenCalledTimes(1);
      expect(deps.failureSink.notify).toHaveBeenCalledWith({
        phase: 'diff-generation',
        modelName: 'User',
        operation: 'update',
        params: operation.args,
        error: auditError,
      });
      expect(deps.writeAuditLogs).not.toHaveBeenCalled();
    });

    it('lets a write failure propagate without reporting it as diff-generation', async () => {
      const writeError = new Error('DB write failed');
      const deps = createDeps({
        writeAuditLogs: vi.fn(async () => {
          throw writeError;
        }),
      });

      await expect(
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient: createBaseClient() }, deps),
      ).rejects.toBe(writeError);

      expect(deps.failureSink.notify).not.toHaveBeenCalled();
    });
  });
});

describe('createExecutor', () => {
  const scope: ExecutionScope = {
    auditContext,
    handle: transactionClient,
    baseHandle: createBaseClient(),
    atomic: true,
  };

  it('runs prepare, execute, collect, produce and result in order and returns the result with the records', async () => {
    const calls: string[] = [];
    const step = <T>(name: string, value: T) =>
      vi.fn(async (): Promise<T> => {
        calls.push(name);
        return value;
      });
    const prepared = { before: null };
    const executed = { id: 'u1' };
    const events = [{ model: 'User', identity: 'u1', action: 'update' as const, origin: { path: '', op: 'update' } }];
    const steps = {
      prepare: step('prepare', prepared),
      execute: step('execute', executed),
      collect: step('collect', events),
      result: step('result', 'hydrated'),
    };
    const produceRecords = vi.fn(async () => {
      calls.push('produce');
      return [record];
    });
    const operation = operationOf();

    const result = await createExecutor(steps, (_operation, error) => error).run(operation, scope, produceRecords);

    expect(calls).toEqual(['prepare', 'execute', 'collect', 'produce', 'result']);
    expect(steps.execute).toHaveBeenCalledWith(operation, scope, prepared);
    expect(steps.collect).toHaveBeenCalledWith(operation, scope, prepared, executed);
    expect(produceRecords).toHaveBeenCalledWith(events, scope);
    expect(steps.result).toHaveBeenCalledWith(operation, scope, executed);
    expect(result).toEqual({ result: 'hydrated', records: [record] });
  });

  it('stops at the first failing step', async () => {
    const execute = vi.fn(async () => {
      throw new Error('execute failed');
    });
    const collect = vi.fn(async () => []);
    const executor = createExecutor(
      { prepare: async () => undefined, execute, collect, result: async () => undefined },
      (_operation, error) => error,
    );

    await expect(executor.run(operationOf(), scope, vi.fn())).rejects.toThrow('execute failed');

    expect(collect).not.toHaveBeenCalled();
  });
});
