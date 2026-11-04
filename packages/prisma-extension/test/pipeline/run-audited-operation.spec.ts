/**
 * Tests for the audited-operation pipeline: the write policy decides the scope, the executor
 * runs inside it through the continuation the scope calls for, its records are dispatched with
 * the scope as the transaction runtime, and each kind of failure reaches the caller and the
 * failure sink the way its origin requires. The transaction an operation runs in is the one its
 * input names; a failure of the audit after the caller's write has run is recorded on that
 * transaction, which keeps it from committing.
 */

import type { AuditContext, AuditRecord } from '@kuruwic/db-audit-core';
import { createActorId, createAggregateId, createEntityId } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaBaseClient, PrismaHandle } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { ExecutedOperation, OperationExecutor } from '../../src/pipeline/executor.js';
import {
  type AuditPipelineDependencies,
  type InterceptedOperation,
  runAuditedOperation,
} from '../../src/pipeline/run-audited-operation.js';
import { flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
import { type ActiveTransaction, isProcessingAuditLog, withScope } from '../../src/runtime/scope.js';
import type { AuditLogData } from '../../src/types.js';
import { activeTransactionOf } from '../support/active-transaction.js';
import { stubFailureSink } from '../support/failure-sink.js';

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

const transactionClientWith = (delegates: Record<string, unknown> = {}): PrismaHandle =>
  Object.assign(Object.create(null), { name: 'transaction', ...delegates });
const transactionClient = transactionClientWith();

interface BaseClientStub extends PrismaBaseClient {
  readonly transactionsOpened: { count: number };
}

const createBaseClient = (
  transaction: PrismaHandle = transactionClient,
  delegates: Record<string, unknown> = {},
): BaseClientStub => {
  const transactionsOpened = { count: 0 };
  return {
    $transaction: async <T>(fn: (tx: PrismaHandle) => Promise<T>): Promise<T> => {
      transactionsOpened.count += 1;
      return fn(transaction);
    },
    $extends: () => {
      throw new Error('not used');
    },
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
  const failureSink = stubFailureSink();
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

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, atomic: true, transaction: undefined },
        deps,
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(baseClient);
      expect(scope.baseClient).toBe(baseClient);
      expect(scope.transaction).toBeUndefined();
      expect(scope.atomic).toBe(true);
      expect(getPendingWriteCount()).toBe(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(baseClient, [record]);
    });

    it('runs on the transaction client and writes immediately in it when the policy is atomic inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const transaction = activeTransactionOf(transactionClient);

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, atomic: true, transaction },
        deps,
      );

      expect(scopeSeenBy(deps.singleExecutor).handle).toBe(transactionClient);
      expect(transaction.deferredWrites).toHaveLength(0);
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
        { operation: interceptedOf(), auditContext, baseClient, atomic: false, transaction: undefined },
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

    it('runs on the transaction client and writes after commit when the policy is not atomic inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const transaction = activeTransactionOf(transactionClient);
      const { deferredWrites } = transaction;

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, atomic: false, transaction },
        deps,
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(transactionClient);
      expect(scope.transaction?.deferredWrites).toBe(deferredWrites);
      expect(deferredWrites).toHaveLength(1);
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      await deferredWrites[0]?.();
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(baseClient, [record]);
    });

    it.each([
      { policy: 'atomic', atomic: true },
      { policy: 'not atomic', atomic: false },
    ])(
      'runs an operation whose input names no transaction outside any, whatever transaction the surrounding scope is bound to, when the policy is $policy',
      async ({ atomic }) => {
        const baseClient = createBaseClient();
        const deps = createDeps();
        const surrounding = activeTransactionOf(transactionClientWith());

        await withScope({ binding: { transaction: surrounding } }, () =>
          runAuditedOperation(
            { operation: interceptedOf(), auditContext, baseClient, atomic, transaction: undefined },
            deps,
          ),
        );
        await flushAllPendingWrites();

        const scope = scopeSeenBy(deps.singleExecutor);
        expect(scope.handle).toBe(baseClient);
        expect(scope.transaction).toBeUndefined();
        expect(surrounding.deferredWrites).toHaveLength(0);
        expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(baseClient, [record]);
      },
    );

    it('writes the audit of an operation by the transaction its input names, whatever transaction the surrounding scope is bound to', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const named = activeTransactionOf(transactionClient);
      const surrounding = activeTransactionOf(transactionClientWith());

      await withScope({ binding: { transaction: surrounding } }, () =>
        runAuditedOperation(
          { operation: interceptedOf(), auditContext, baseClient, atomic: true, transaction: named },
          deps,
        ),
      );

      expect(scopeSeenBy(deps.singleExecutor).handle).toBe(named.client);
      expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(named.client, [record]);
      expect(surrounding.deferredWrites).toHaveLength(0);
    });

    it('queues the writes after commit of several operations in one transaction in order', async () => {
      const second: AuditLogData = { ...record, entityId: createEntityId('u2') };
      const outcomes = [outcome, executedWith([second])];
      const deps = createDeps({ singleExecutor: stubExecutor(async () => outcomes.shift() ?? outcome) });
      const baseClient = createBaseClient();
      const transaction = activeTransactionOf(transactionClient);
      const { deferredWrites } = transaction;

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, atomic: false, transaction },
        deps,
      );
      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, atomic: false, transaction },
        deps,
      );

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
      start: (baseClient: PrismaBaseClient, transaction: ActiveTransaction | undefined) => Promise<unknown>,
    ) => Promise<unknown>;

    it.each<{ path: string; atomic: boolean; run: Run }>([
      {
        path: "inside the caller's own transaction",
        atomic: true,
        run: (update, start) =>
          start(createBaseClient(), activeTransactionOf(transactionClientWith({ user: { update } }))),
      },
      {
        path: 'when the policy is not atomic',
        atomic: false,
        run: (update, start) => start(createBaseClient(transactionClient, { user: { update } }), undefined),
      },
    ])('continues the operation through query, never through the client delegate, $path', async ({ atomic, run }) => {
      const update = vi.fn();
      const deps = createDeps({ singleExecutor: runningTheOperation() });
      const operation = interceptedOf();

      await run(update, (baseClient, transaction) =>
        runAuditedOperation({ operation, auditContext, baseClient, atomic, transaction }, deps),
      );

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
        runAuditedOperation(
          { operation, auditContext, baseClient: createBaseClient(), atomic: true, transaction: undefined },
          deps,
        ),
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
    ])("propagates the caller's own mutation error thrown through query $path as it is", async ({ atomic }) => {
      const callerError = new Error('Unique constraint failed on the fields: (`email`)');
      const operation = interceptedOf(
        'update',
        vi.fn(async () => {
          throw callerError;
        }),
      );
      const deps = createDeps({ singleExecutor: runningTheOperation() });

      await expect(
        runAuditedOperation(
          { operation, auditContext, baseClient: createBaseClient(), atomic, transaction: undefined },
          deps,
        ),
      ).rejects.toBe(callerError);

      expect(Object.getOwnPropertySymbols(callerError)).toEqual([]);
      expect(deps.failureSink.notify).not.toHaveBeenCalled();
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
    });

    it.each([
      { thrown: 'a frozen Error', value: Object.freeze(new Error('denied')) },
      { thrown: 'an object that is not an Error', value: { code: 'TENANT_DENIED' } },
      { thrown: 'a string', value: 'denied' },
    ])("propagates $thrown the caller's own mutation throws through query as it is", async ({ value }) => {
      const operation = interceptedOf(
        'update',
        vi.fn(async () => {
          throw value;
        }),
      );
      const deps = createDeps({ singleExecutor: runningTheOperation() });

      await expect(
        runAuditedOperation(
          { operation, auditContext, baseClient: createBaseClient(), atomic: false, transaction: undefined },
          deps,
        ),
      ).rejects.toBe(value);

      expect(deps.failureSink.notify).not.toHaveBeenCalled();
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
    });
  });

  describe('executor', () => {
    it('routes a batch action to the batch executor and any other action to the single executor', async () => {
      const deps = createDeps();
      const baseClient = createBaseClient();

      await runAuditedOperation(
        { operation: interceptedOf('updateMany'), auditContext, baseClient, atomic: true, transaction: undefined },
        deps,
      );
      await runAuditedOperation(
        { operation: interceptedOf('upsert'), auditContext, baseClient, atomic: true, transaction: undefined },
        deps,
      );

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
        {
          operation: interceptedOf(),
          auditContext,
          baseClient: createBaseClient(),
          atomic: true,
          transaction: undefined,
        },
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
          runAuditedOperation(
            { operation, auditContext, baseClient: createBaseClient(), atomic: true, transaction: undefined },
            deps,
          ),
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

      it.each([
        { policy: 'atomic', atomic: true },
        { policy: 'not atomic', atomic: false },
      ])(
        'rejects with the original error, queues nothing and records the failure on the transaction when the policy is $policy inside a transaction',
        async ({ atomic }) => {
          const deps = createDeps({ singleExecutor: failingBuildExecutor() });
          const transaction = activeTransactionOf(transactionClient);

          await expect(
            runAuditedOperation(
              { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic, transaction },
              deps,
            ),
          ).rejects.toBe(buildError);

          expect(deps.failureSink.notify).toHaveBeenCalledTimes(1);
          if (atomic) {
            expect(deps.failureSink.notify).toHaveBeenCalledWith(buildFailure);
          }
          expect(transaction.deferredWrites).toHaveLength(0);
          expect(transaction.auditFailures).toEqual([buildError]);
          expect(auditWriteOf(deps)).not.toHaveBeenCalled();
        },
      );

      it.each([
        { policy: 'atomic', atomic: true },
        { policy: 'not atomic', atomic: false },
      ])(
        'returns the result, reports the dropped records and writes nothing when the policy is $policy outside any transaction',
        async ({ atomic }) => {
          const deps = createDeps({ singleExecutor: failingBuildExecutor() });
          const surrounding = activeTransactionOf(transactionClientWith());

          await expect(
            withScope({ binding: { transaction: surrounding } }, () =>
              runAuditedOperation(
                {
                  operation: interceptedOf(),
                  auditContext,
                  baseClient: createBaseClient(),
                  atomic,
                  transaction: undefined,
                },
                deps,
              ),
            ),
          ).resolves.toBe(outcome.result);

          expect(deps.failureSink.reportDroppedBuild).toHaveBeenCalledExactlyOnceWith(buildFailure);
          expect(deps.failureSink.notify).not.toHaveBeenCalled();
          expect(surrounding.auditFailures).toEqual([]);
          expect(getPendingWriteCount()).toBe(0);
          expect(auditWriteOf(deps)).not.toHaveBeenCalled();
        },
      );
    });

    describe('a failed write of the records', () => {
      const writeError = new Error('DB write failed');
      const failingWriteDeps = (failureSink = stubFailureSink()) =>
        createDeps({
          dispatchConfig: {
            writeExecutor: {
              write: vi.fn(async () => {
                throw writeError;
              }),
            },
            failureSink,
          },
          failureSink,
        });

      it('lets a write failure inside a transaction propagate without reporting it as diff-generation, and records it on the transaction', async () => {
        const failureSink = stubFailureSink();
        vi.mocked(failureSink.reportWriteFailure).mockImplementation(async (_plan, error) => {
          throw error;
        });
        const deps = failingWriteDeps(failureSink);
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), atomic: true, transaction },
            deps,
          ),
        ).rejects.toBe(writeError);

        expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'immediate' }),
          writeError,
        );
        expect(failureSink.notify).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'diff-generation' }));
        expect(transaction.auditFailures).toEqual([writeError]);
      });

      it('returns the result and records nothing when the write fails outside any transaction', async () => {
        const failureSink = stubFailureSink();
        const deps = failingWriteDeps(failureSink);
        const surrounding = activeTransactionOf(transactionClientWith());

        await expect(
          withScope({ binding: { transaction: surrounding } }, () =>
            runAuditedOperation(
              {
                operation: interceptedOf(),
                auditContext,
                baseClient: createBaseClient(),
                atomic: true,
                transaction: undefined,
              },
              deps,
            ),
          ),
        ).resolves.toBe(outcome.result);

        expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'awaited-after-commit' }),
          writeError,
        );
        expect(surrounding.auditFailures).toEqual([]);
      });
    });

    describe('a failure of the executor', () => {
      const executorError = new Error('read between the rounds failed');
      const mutationError = new Error('Unique constraint failed on the fields: (`email`)');
      const failingQuery = () =>
        vi.fn(async () => {
          throw mutationError;
        });

      it("does not record the caller's own mutation failure on the transaction", async () => {
        const executor = stubExecutor(async (operation) => {
          await operation.execute(operation.args);
          return outcome;
        });
        const deps = createDeps({ singleExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            {
              operation: interceptedOf('update', failingQuery()),
              auditContext,
              baseClient: createBaseClient(),
              atomic: true,
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(mutationError);

        expect(transaction.auditFailures).toEqual([]);
      });

      it("records the caller's own mutation failure on the transaction when an earlier round of the operation wrote, and rethrows it untouched", async () => {
        const executor = stubExecutor(async (operation) => {
          await operation.execute(operation.args);
          await operation.execute(operation.args);
          return outcome;
        });
        const query = vi
          .fn(async (): Promise<unknown> => 'written')
          .mockResolvedValueOnce('written')
          .mockRejectedValueOnce(mutationError);
        const deps = createDeps({ batchExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            {
              operation: interceptedOf('updateMany', query),
              auditContext,
              baseClient: createBaseClient(),
              atomic: true,
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(mutationError);

        expect(query).toHaveBeenCalledTimes(2);
        expect(deps.failureSink.notify).not.toHaveBeenCalled();
        expect(transaction.auditFailures).toEqual([mutationError]);
      });

      it('does not record a failure before the write on the transaction', async () => {
        const executor = stubExecutor(async () => {
          throw executorError;
        });
        const query = vi.fn();
        const deps = createDeps({ singleExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            {
              operation: interceptedOf('update', query),
              auditContext,
              baseClient: createBaseClient(),
              atomic: true,
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(executorError);

        expect(query).not.toHaveBeenCalled();
        expect(transaction.auditFailures).toEqual([]);
      });

      it("records a failure after the caller's mutation succeeded on the transaction, and rethrows it", async () => {
        const executor = stubExecutor(async (operation) => {
          await operation.execute(operation.args);
          throw executorError;
        });
        const query = vi.fn(async () => 'written');
        const deps = createDeps({ singleExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            {
              operation: interceptedOf('update', query),
              auditContext,
              baseClient: createBaseClient(),
              atomic: true,
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(executorError);

        expect(query).toHaveBeenCalledTimes(1);
        expect(deps.failureSink.notify).toHaveBeenCalledWith(
          expect.objectContaining({ phase: 'diff-generation', error: executorError }),
        );
        expect(transaction.auditFailures).toEqual([executorError]);
      });

      it('records nothing on a transaction when the operation is bound to none, whatever the executor fails with after the write', async () => {
        const executor = stubExecutor(async (operation) => {
          await operation.execute(operation.args);
          throw executorError;
        });
        const deps = createDeps({ singleExecutor: executor });
        const surrounding = activeTransactionOf(transactionClientWith());

        await expect(
          withScope({ binding: { transaction: surrounding } }, () =>
            runAuditedOperation(
              {
                operation: interceptedOf(
                  'update',
                  vi.fn(async () => 'written'),
                ),
                auditContext,
                baseClient: createBaseClient(),
                atomic: true,
                transaction: undefined,
              },
              deps,
            ),
          ),
        ).rejects.toBe(executorError);

        expect(surrounding.auditFailures).toEqual([]);
      });
    });
  });
});
