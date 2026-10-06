/**
 * Tests for the audited-operation pipeline: the write policy decides the scope, the executor
 * runs inside it through the continuation the scope calls for, its records are dispatched with
 * the scope as the transaction runtime, and each kind of failure reaches the caller and the
 * failure sink the way its origin requires.
 */

import type { AuditContext, AuditRecord, FailureSink } from '@kuruwic/db-audit-core';
import { createActorId, createAggregateId, createEntityId, createFailureSink } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { ExecutedOperation, OperationExecutor } from '../../src/pipeline/executor.js';
import {
  type AuditPipelineDependencies,
  type InterceptedOperation,
  runAuditedOperation,
} from '../../src/pipeline/run-audited-operation.js';
import { flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
import { isProcessingAuditLog, withScope } from '../../src/runtime/scope.js';
import type { AuditLogData } from '../../src/types.js';
import { isCallerMutationError } from '../../src/utils/caller-mutation-error.js';

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
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const args = { where: { id: 'u1' }, data: { name: 'Anne' } };

const interceptedOf = (
  action: InterceptedOperation['action'] = 'update',
  query: InterceptedOperation['query'] = vi.fn(),
): InterceptedOperation => ({ model: 'User', action, args, query, widened: new Map() });

const executedWith = (records: AuditRecord[]): ExecutedOperation => ({
  result: { id: 'u1', name: 'Anne' },
  buildRecords: async () => records,
});

const outcome = executedWith([record]);

const stubExecutor = (run: OperationExecutor['run']): OperationExecutor => ({ run: vi.fn(run) });

const succeedingExecutor = () => stubExecutor(async () => outcome);

const createDeps = (overrides: Partial<AuditPipelineDependencies> = {}) => {
  const failureSink: FailureSink = {
    notify: vi.fn(async () => {}),
    reportResolverFailures: vi.fn(async () => {}),
    reportDroppedBuild: vi.fn(async () => {}),
    reportWriteFailure: vi.fn(async () => {}),
  };
  const deps: AuditPipelineDependencies = {
    singleExecutor: succeedingExecutor(),
    batchExecutor: succeedingExecutor(),
    produceRecords: vi.fn(async () => [record]),
    dispatchConfig: { writeExecutor: { write: vi.fn(async () => {}) }, failureSink },
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

const auditWriteOf = (deps: AuditPipelineDependencies) => vi.mocked(deps.dispatchConfig.writeExecutor.write);

describe('runAuditedOperation', () => {
  describe('policy and scope', () => {
    it('runs on the base client without opening a transaction when the policy is atomic outside any, and awaits the write', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();

      await runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient, atomic: true }, deps);

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(baseClient);
      expect(scope.baseClient).toBe(baseClient);
      expect(scope.transaction).toBeUndefined();
      expect(scope.atomic).toBe(true);
      expect(getPendingWriteCount()).toBe(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(baseClient, [record]);
    });

    it('runs on the active transaction client and writes immediately in it when the policy is atomic inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const deferredWrites: Array<() => Promise<void>> = [];

      await withScope({ transaction: { client: transactionClient, deferredWrites } }, () =>
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient, atomic: true }, deps),
      );

      expect(scopeSeenBy(deps.singleExecutor).handle).toBe(transactionClient);
      expect(deferredWrites).toHaveLength(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(transactionClient, [record]);
    });

    it('runs on the base client without a transaction when the policy is not atomic, and detaches the write', async () => {
      const baseClient = createBaseClient();
      let finishWrite: () => void = () => {};
      const write = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      );
      const deps = createDeps();
      const dispatchConfig = { ...deps.dispatchConfig, writeExecutor: { write } };

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, atomic: false },
        { ...deps, dispatchConfig },
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(baseClient);
      expect(scope.transaction).toBeUndefined();
      expect(scope.atomic).toBe(false);
      expect(getPendingWriteCount()).toBe(1);
      finishWrite();
      await flushAllPendingWrites();
      expect(write).toHaveBeenCalledWith(baseClient, [record]);
    });

    it('runs on the active transaction client and writes after commit when the policy is not atomic inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const deferredWrites: Array<() => Promise<void>> = [];

      await withScope({ transaction: { client: transactionClient, deferredWrites } }, () =>
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient, atomic: false }, deps),
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(transactionClient);
      expect(scope.transaction).toEqual({ deferredWrites });
      expect(deferredWrites).toHaveLength(1);
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      await deferredWrites[0]?.();
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(baseClient, [record]);
    });

    it.each([
      ['inside a batch Prisma runs', true],
      ['outside any batch', false],
    ])('tells the executor whether the operation runs %s from the runtime scope', async (_name, inPrismaBatch) => {
      const baseClient = createBaseClient();
      const deps = createDeps();

      await withScope({ isInPrismaBatch: inPrismaBatch }, () =>
        runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient, atomic: true }, deps),
      );

      expect(scopeSeenBy(deps.singleExecutor).inPrismaBatch).toBe(inPrismaBatch);
    });

    it('queues the writes after commit of several operations in one transaction in order', async () => {
      const second: AuditLogData = { ...record, entityId: createEntityId('u2') };
      const outcomes = [outcome, executedWith([second])];
      const deps = createDeps({ singleExecutor: stubExecutor(async () => outcomes.shift() ?? outcome) });
      const baseClient = createBaseClient();
      const deferredWrites: Array<() => Promise<void>> = [];

      await withScope({ transaction: { client: transactionClient, deferredWrites } }, async () => {
        await runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient, atomic: false }, deps);
        await runAuditedOperation({ operation: interceptedOf(), auditContext, baseClient, atomic: false }, deps);
      });

      expect(deferredWrites).toHaveLength(2);
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      for (const deferredWrite of deferredWrites) {
        await deferredWrite();
      }
      expect(auditWriteOf(deps).mock.calls.map(([, written]) => written)).toEqual([[record], [second]]);
    });
  });

  describe('continuation', () => {
    const runningTheOperation = () =>
      stubExecutor(async (operation) => {
        await operation.execute(operation.args);
        return outcome;
      });

    type Run = (
      update: () => void,
      start: (baseClient: PrismaClientWithDynamicAccess) => Promise<unknown>,
    ) => Promise<unknown>;

    it.each<{ path: string; atomic: boolean; run: Run }>([
      {
        path: "inside the caller's own transaction",
        atomic: true,
        run: (update, start) =>
          withScope({ transaction: { client: transactionClientWith({ user: { update } }), deferredWrites: [] } }, () =>
            start(createBaseClient()),
          ),
      },
      {
        path: 'when the policy is not atomic',
        atomic: false,
        run: (update, start) => start(createBaseClient(transactionClient, { user: { update } })),
      },
    ])('continues the operation through query, never through the client delegate, $path', async ({ atomic, run }) => {
      const update = vi.fn();
      const deps = createDeps({ singleExecutor: runningTheOperation() });
      const operation = interceptedOf();

      await run(update, (baseClient) => runAuditedOperation({ operation, auditContext, baseClient, atomic }, deps));

      expect(operation.query).toHaveBeenCalledWith(args);
      expect(update).not.toHaveBeenCalled();
    });

    it("runs the caller's operation with the processing flag lowered and the audit's own work with it raised", async () => {
      const flagSeen: Array<[string, boolean]> = [];
      const operation = interceptedOf(
        'update',
        vi.fn(async () => {
          flagSeen.push(['query', isProcessingAuditLog()]);
        }),
      );
      const executor = stubExecutor(async (executed) => {
        flagSeen.push(['read before', isProcessingAuditLog()]);
        await executed.execute(executed.args);
        flagSeen.push(['read after', isProcessingAuditLog()]);
        return outcome;
      });
      const deps = createDeps({ singleExecutor: executor });

      await withScope({ isProcessingAuditLog: true }, () =>
        runAuditedOperation({ operation, auditContext, baseClient: createBaseClient(), atomic: true }, deps),
      );

      expect(flagSeen).toEqual([
        ['read before', true],
        ['query', false],
        ['read after', true],
      ]);
    });

    it.each([
      { path: 'outside any transaction', atomic: false },
      { path: 'with an atomic policy', atomic: true },
    ])("tags the caller's own mutation error thrown through query $path so it propagates raw", async ({ atomic }) => {
      const callerError = new Error('Unique constraint failed on the fields: (`email`)');
      const operation = interceptedOf(
        'update',
        vi.fn(async () => {
          throw callerError;
        }),
      );
      const deps = createDeps({ singleExecutor: runningTheOperation() });

      await expect(
        runAuditedOperation({ operation, auditContext, baseClient: createBaseClient(), atomic }, deps),
      ).rejects.toBe(callerError);

      expect(isCallerMutationError(callerError)).toBe(true);
      expect(deps.failureSink.notify).not.toHaveBeenCalled();
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
    });
  });

  describe('executor', () => {
    it('routes a batch action to the batch executor and any other action to the single executor', async () => {
      const deps = createDeps();
      const baseClient = createBaseClient();

      await runAuditedOperation(
        { operation: interceptedOf('updateMany'), auditContext, baseClient, atomic: true },
        deps,
      );
      await runAuditedOperation({ operation: interceptedOf('upsert'), auditContext, baseClient, atomic: true }, deps);

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
        { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: true },
        deps,
      );

      expect(result).toBe(outcome.result);
      expect(deps.failureSink.notify).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it.each([
      ['single', 'update'],
      ['batch', 'updateMany'],
    ] as const)(
      'reports any other %s executor failure before the write once as diff-generation and rethrows the original error',
      async (_path, action) => {
        const auditError = new Error('diff calculation failed');
        const failingExecutor = stubExecutor(async () => {
          throw auditError;
        });
        const deps = createDeps({ singleExecutor: failingExecutor, batchExecutor: failingExecutor });
        const operation = interceptedOf(action);

        await expect(
          runAuditedOperation({ operation, auditContext, baseClient: createBaseClient(), atomic: true }, deps),
        ).rejects.toBe(auditError);

        expect(deps.failureSink.notify).toHaveBeenCalledTimes(1);
        expect(deps.failureSink.notify).toHaveBeenCalledWith({
          phase: 'diff-generation',
          modelName: 'User',
          operation: action,
          params: operation.args,
          error: auditError,
        });
        expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      },
    );

    describe('a failed build of the records after the write', () => {
      const buildError = new Error('read after the write failed');
      const failingBuildExecutor = () =>
        stubExecutor(async () => ({
          result: outcome.result,
          buildRecords: async () => {
            throw buildError;
          },
        }));
      const buildFailure = {
        phase: 'diff-generation',
        modelName: 'User',
        operation: 'update',
        params: args,
        error: buildError,
      };

      it('rejects with the original error when the policy is atomic inside a transaction', async () => {
        const deps = createDeps({ singleExecutor: failingBuildExecutor() });

        await expect(
          withScope({ transaction: { client: transactionClient, deferredWrites: [] } }, () =>
            runAuditedOperation(
              { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: true },
              deps,
            ),
          ),
        ).rejects.toBe(buildError);

        expect(deps.failureSink.notify).toHaveBeenCalledTimes(1);
        expect(deps.failureSink.notify).toHaveBeenCalledWith(buildFailure);
        expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      });

      it('returns the result and reports the dropped records when the policy is atomic outside any transaction', async () => {
        const deps = createDeps({ singleExecutor: failingBuildExecutor() });

        await expect(
          runAuditedOperation(
            { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: true },
            deps,
          ),
        ).resolves.toBe(outcome.result);

        expect(deps.failureSink.reportDroppedBuild).toHaveBeenCalledWith(buildFailure);
        expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      });

      it('rejects with the original error when the policy is not atomic inside a transaction', async () => {
        const deps = createDeps({ singleExecutor: failingBuildExecutor() });
        const deferredWrites: Array<() => Promise<void>> = [];

        await expect(
          withScope({ transaction: { client: transactionClient, deferredWrites } }, () =>
            runAuditedOperation(
              { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: false },
              deps,
            ),
          ),
        ).rejects.toBe(buildError);

        expect(deps.failureSink.notify).toHaveBeenCalledTimes(1);
        expect(deferredWrites).toHaveLength(0);
      });

      it('returns the result and writes nothing when the policy is not atomic outside any transaction', async () => {
        const deps = createDeps({ singleExecutor: failingBuildExecutor() });

        await expect(
          runAuditedOperation(
            { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: false },
            deps,
          ),
        ).resolves.toBe(outcome.result);

        expect(deps.failureSink.reportDroppedBuild).toHaveBeenCalledTimes(1);
        expect(deps.failureSink.reportDroppedBuild).toHaveBeenCalledWith(buildFailure);
        expect(deps.failureSink.notify).not.toHaveBeenCalled();
        expect(getPendingWriteCount()).toBe(0);
        expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      });
    });

    it('lets a write failure inside a transaction propagate without reporting it as diff-generation', async () => {
      const writeError = new Error('DB write failed');
      const deps = createDeps({
        dispatchConfig: {
          writeExecutor: {
            write: vi.fn(async () => {
              throw writeError;
            }),
          },
          failureSink: createFailureSink({ writeFailurePolicy: 'throw' }),
        },
      });

      await expect(
        withScope({ transaction: { client: transactionClient, deferredWrites: [] } }, () =>
          runAuditedOperation(
            { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: true },
            deps,
          ),
        ),
      ).rejects.toBe(writeError);

      expect(deps.failureSink.notify).not.toHaveBeenCalled();
    });
  });
});
