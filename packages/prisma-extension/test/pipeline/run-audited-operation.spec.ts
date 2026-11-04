/**
 * Tests for the audited-operation pipeline: the transaction its input names decides the scope, the
 * executor runs inside it through the continuation the scope calls for, its records are dispatched
 * by the write plan its input names with the scope as the transaction runtime, an atomic operation
 * some of whose records a reported failure dropped fails, and each kind of failure reaches the
 * caller and the failure sink the way its origin requires. The transaction an operation runs in is
 * the one its input names; a failure of the audit after the caller's write has run is recorded on
 * that transaction, which keeps it from committing.
 */

import type { AuditContext, AuditErrorContext, AuditRecord, WriteMode, WritePlanKind } from '@kuruwic/db-audit-core';
import { AuditIncompleteError, createActorId, createAggregateId, createEntityId } from '@kuruwic/db-audit-core';
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
import {
  type ActiveTransaction,
  isProcessingAuditLog,
  keepOperationFailure,
  withScope,
} from '../../src/runtime/scope.js';
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
  describe('write plan and scope', () => {
    it('runs on the base client without opening a transaction when the mode is awaited outside any transaction, and awaits the write', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();

      await runAuditedOperation(
        {
          operation: interceptedOf(),
          auditContext,
          baseClient,
          mode: 'awaited',
          plan: 'awaited-after-commit',
          transaction: undefined,
        },
        deps,
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(baseClient);
      expect(scope.baseClient).toBe(baseClient);
      expect(scope.transaction).toBeUndefined();
      expect(getPendingWriteCount()).toBe(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(baseClient, [record]);
    });

    it('runs on the transaction client and writes immediately in it when the mode is atomic inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const transaction = activeTransactionOf(transactionClient);

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, mode: 'atomic', plan: 'immediate', transaction },
        deps,
      );

      expect(scopeSeenBy(deps.singleExecutor).handle).toBe(transactionClient);
      expect(transaction.deferredWrites).toHaveLength(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(transactionClient, [record]);
    });

    it('runs on the base client without a transaction when the mode is deferred, and detaches the write', async () => {
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
        {
          operation: interceptedOf(),
          auditContext,
          baseClient,
          mode: 'deferred',
          plan: 'detached',
          transaction: undefined,
        },
        { ...deps, dispatchConfig },
      );

      expect(baseClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(baseClient);
      expect(scope.transaction).toBeUndefined();
      expect(getPendingWriteCount()).toBe(1);
      finishWrite();
      await flushAllPendingWrites();
      expect(write).toHaveBeenCalledWith(baseClient, [record]);
    });

    it('runs on the transaction client and writes after commit when the mode is deferred inside a transaction', async () => {
      const baseClient = createBaseClient();
      const deps = createDeps();
      const transaction = activeTransactionOf(transactionClient);
      const { deferredWrites } = transaction;

      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, mode: 'deferred', plan: 'after-commit', transaction },
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
      { mode: 'awaited', plan: 'awaited-after-commit' },
      { mode: 'deferred', plan: 'detached' },
    ] as const)(
      'runs an operation whose input names no transaction outside any, whatever transaction the surrounding scope is bound to, when the mode is $mode',
      async ({ mode, plan }) => {
        const baseClient = createBaseClient();
        const deps = createDeps();
        const surrounding = activeTransactionOf(transactionClientWith());

        await withScope({ binding: { transaction: surrounding } }, () =>
          runAuditedOperation(
            { operation: interceptedOf(), auditContext, baseClient, mode, plan, transaction: undefined },
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
          {
            operation: interceptedOf(),
            auditContext,
            baseClient,
            mode: 'atomic',
            plan: 'immediate',
            transaction: named,
          },
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
        { operation: interceptedOf(), auditContext, baseClient, mode: 'deferred', plan: 'after-commit', transaction },
        deps,
      );
      await runAuditedOperation(
        { operation: interceptedOf(), auditContext, baseClient, mode: 'deferred', plan: 'after-commit', transaction },
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

    it.each<{ path: string; mode: WriteMode; plan: WritePlanKind; run: Run }>([
      {
        path: "inside the caller's own transaction",
        mode: 'atomic',
        plan: 'immediate',
        run: (update, start) =>
          start(createBaseClient(), activeTransactionOf(transactionClientWith({ user: { update } }))),
      },
      {
        path: 'when the mode is deferred',
        mode: 'deferred',
        plan: 'detached',
        run: (update, start) => start(createBaseClient(transactionClient, { user: { update } }), undefined),
      },
    ])(
      'continues the operation through query, never through the client delegate, $path',
      async ({ mode, plan, run }) => {
        const update = vi.fn();
        const deps = createDeps({ singleExecutor: runningTheOperation() });
        const operation = interceptedOf();

        await run(update, (baseClient, transaction) =>
          runAuditedOperation({ operation, auditContext, baseClient, mode, plan, transaction }, deps),
        );

        expect(operation.query).toHaveBeenCalledWith(args);
        expect(update).not.toHaveBeenCalled();
      },
    );

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
          {
            operation,
            auditContext,
            baseClient: createBaseClient(),
            mode: 'awaited',
            plan: 'awaited-after-commit',
            transaction: undefined,
          },
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
      { path: 'when the mode is deferred', mode: 'deferred', plan: 'detached' },
      { path: 'when the mode is awaited', mode: 'awaited', plan: 'awaited-after-commit' },
    ] as const)(
      "propagates the caller's own mutation error thrown through query $path as it is",
      async ({ mode, plan }) => {
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
            { operation, auditContext, baseClient: createBaseClient(), mode, plan, transaction: undefined },
            deps,
          ),
        ).rejects.toBe(callerError);

        expect(Object.getOwnPropertySymbols(callerError)).toEqual([]);
        expect(deps.failureSink.notify).not.toHaveBeenCalled();
        expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      },
    );

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
          {
            operation,
            auditContext,
            baseClient: createBaseClient(),
            mode: 'deferred',
            plan: 'detached',
            transaction: undefined,
          },
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
        {
          operation: interceptedOf('updateMany'),
          auditContext,
          baseClient,
          mode: 'awaited',
          plan: 'awaited-after-commit',
          transaction: undefined,
        },
        deps,
      );
      await runAuditedOperation(
        {
          operation: interceptedOf('upsert'),
          auditContext,
          baseClient,
          mode: 'awaited',
          plan: 'awaited-after-commit',
          transaction: undefined,
        },
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
          mode: 'awaited',
          plan: 'awaited-after-commit',
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
            {
              operation,
              auditContext,
              baseClient: createBaseClient(),
              mode: 'awaited',
              plan: 'awaited-after-commit',
              transaction: undefined,
            },
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
        { mode: 'atomic', plan: 'immediate' },
        { mode: 'deferred', plan: 'after-commit' },
      ] as const)(
        'rejects with the original error, queues nothing and records the failure on the transaction when the mode is $mode inside a transaction',
        async ({ mode, plan }) => {
          const deps = createDeps({ singleExecutor: failingBuildExecutor() });
          const transaction = activeTransactionOf(transactionClient);

          await expect(
            runAuditedOperation(
              { operation: interceptedOf(), auditContext, baseClient: createBaseClient(), mode, plan, transaction },
              deps,
            ),
          ).rejects.toBe(buildError);

          expect(deps.failureSink.notify).toHaveBeenCalledTimes(1);
          if (mode === 'atomic') {
            expect(deps.failureSink.notify).toHaveBeenCalledWith(buildFailure);
          }
          expect(transaction.deferredWrites).toHaveLength(0);
          expect(transaction.auditFailures).toEqual([buildError]);
          expect(auditWriteOf(deps)).not.toHaveBeenCalled();
        },
      );

      it.each([
        { mode: 'awaited', plan: 'awaited-after-commit' },
        { mode: 'deferred', plan: 'detached' },
      ] as const)(
        'returns the result, reports the dropped records and writes nothing when the mode is $mode outside any transaction',
        async ({ mode, plan }) => {
          const deps = createDeps({ singleExecutor: failingBuildExecutor() });
          const surrounding = activeTransactionOf(transactionClientWith());

          await expect(
            withScope({ binding: { transaction: surrounding } }, () =>
              runAuditedOperation(
                {
                  operation: interceptedOf(),
                  auditContext,
                  baseClient: createBaseClient(),
                  mode,
                  plan,
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
            {
              operation: interceptedOf(),
              auditContext,
              baseClient: createBaseClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
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
                mode: 'awaited',
                plan: 'awaited-after-commit',
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
              mode: 'atomic',
              plan: 'immediate',
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
              mode: 'atomic',
              plan: 'immediate',
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
              mode: 'atomic',
              plan: 'immediate',
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
              mode: 'atomic',
              plan: 'immediate',
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
                mode: 'awaited',
                plan: 'awaited-after-commit',
                transaction: undefined,
              },
              deps,
            ),
          ),
        ).rejects.toBe(executorError);

        expect(surrounding.auditFailures).toEqual([]);
      });
    });

    describe('a failure kept for the operation', () => {
      const failureOf = (phase: AuditErrorContext['phase'], operation: string): AuditErrorContext => ({
        phase,
        modelName: 'User',
        operation,
        params: args,
        error: new Error(`${phase} failed`),
      });
      const keepingExecutor = (failure: AuditErrorContext) =>
        stubExecutor(async (operation) => {
          await operation.execute(operation.args);
          keepOperationFailure(failure);
          return outcome;
        });

      it('rejects an atomic operation a row-identification failure dropped a record of, once its records are written, and records the rejection on the transaction', async () => {
        const failure = failureOf('row-identification', 'updateMany');
        const deps = createDeps({ batchExecutor: keepingExecutor(failure) });
        const transaction = activeTransactionOf(transactionClient);

        const run = runAuditedOperation(
          {
            operation: interceptedOf(
              'updateMany',
              vi.fn(async () => 'written'),
            ),
            auditContext,
            baseClient: createBaseClient(),
            mode: 'atomic',
            plan: 'immediate',
            transaction,
          },
          deps,
        );

        await expect(run).rejects.toBeInstanceOf(AuditIncompleteError);
        const rejection = await run.catch((error: unknown) => error);
        expect(rejection).toMatchObject({ modelName: 'User', operation: 'updateMany', failures: [failure] });
        expect((rejection as Error).cause).toEqual([failure]);
        expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(transactionClient, [record]);
        expect(transaction.auditFailures).toEqual([rejection]);
      });

      it('resolves an awaited operation a row-identification failure dropped a record of', async () => {
        const deps = createDeps({ batchExecutor: keepingExecutor(failureOf('row-identification', 'updateMany')) });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            {
              operation: interceptedOf(
                'updateMany',
                vi.fn(async () => 'written'),
              ),
              auditContext,
              baseClient: createBaseClient(),
              mode: 'awaited',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).resolves.toBe(outcome.result);

        expect(transaction.auditFailures).toEqual([]);
      });

      it('resolves an atomic operation whose update entry a pre-fetch failure left without its before state', async () => {
        const deps = createDeps({ singleExecutor: keepingExecutor(failureOf('pre-fetch', 'update')) });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runAuditedOperation(
            {
              operation: interceptedOf(
                'update',
                vi.fn(async () => 'written'),
              ),
              auditContext,
              baseClient: createBaseClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).resolves.toBe(outcome.result);

        expect(transaction.auditFailures).toEqual([]);
      });
    });
  });
});
