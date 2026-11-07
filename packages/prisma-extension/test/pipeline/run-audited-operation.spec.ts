/**
 * Tests for the audited-operation pipeline: the transaction its input names decides the scope, the
 * executor runs inside it through the continuation the scope calls for, its records are dispatched
 * by the write plan its input names with the scope as the transaction runtime, an atomic operation
 * some of whose records a reported failure dropped fails, and each kind of failure reaches the
 * caller and the operation's outcome the way its origin requires. The transaction an operation runs in is
 * the one its input names; a failure of the audit after the caller's write has run is recorded on
 * that transaction, which keeps it from committing.
 */

import type {
  AuditContext,
  AuditFailure,
  AuditRecord,
  UnrecordedWrite,
  WriteMode,
  WritePlanKind,
} from '@kuruwic/db-audit-core';
import {
  AuditIncompleteError,
  createActorId,
  createAggregateId,
  createEntityId,
  createOperationOutcome,
} from '@kuruwic/db-audit-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaBaseClient, PrismaHandle } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { ExecutedOperation, OperationExecutor } from '../../src/pipeline/executor.js';
import {
  type AuditedOperationInput,
  type AuditPipelineDependencies,
  type InterceptedOperation,
  runAuditedOperation,
} from '../../src/pipeline/run-audited-operation.js';
import { clearPendingWrites, flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
import { type ActiveTransaction, withinAudit, withScope } from '../../src/runtime/scope.js';
import type { AuditLogData } from '../../src/types.js';
import { activeTransactionOf, recordedFailuresOf } from '../support/active-transaction.js';

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

const transactionClientWith = (delegates: Record<string, unknown> = {}): PrismaHandle =>
  Object.assign(Object.create(null), { name: 'transaction', ...delegates });
const transactionClient = transactionClientWith();

interface AuditedClientStub extends PrismaBaseClient {
  readonly transactionsOpened: { count: number };
}

const createAuditedClient = (
  transaction: PrismaHandle = transactionClient,
  delegates: Record<string, unknown> = {},
): AuditedClientStub => {
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

const executedUpdate = executedWith([record]);

const stubExecutor = (run: OperationExecutor['run']): OperationExecutor => ({ run: vi.fn(run) });

const succeedingExecutor = () => stubExecutor(async () => executedUpdate);

const createDeps = (overrides: Partial<AuditPipelineDependencies> = {}) => {
  const deps: AuditPipelineDependencies = {
    singleExecutor: succeedingExecutor(),
    batchExecutor: succeedingExecutor(),
    produceRecords: vi.fn(async () => [record]),
    dispatchConfig: { writeExecutor: { write: vi.fn(async () => {}) } },
    ...overrides,
  };
  return deps;
};

/** The failures the outcomes of the operations run with each `deps` kept */
const keptFailures = new WeakMap<AuditPipelineDependencies, AuditFailure[]>();

const failuresOf = (deps: AuditPipelineDependencies): AuditFailure[] => {
  let failures = keptFailures.get(deps);
  if (!failures) {
    failures = [];
    keptFailures.set(deps, failures);
  }
  return failures;
};

/** Runs the operation with an outcome of its own, whose failures `failuresOf(deps)` lists */
const runOperation = (input: Omit<AuditedOperationInput, 'outcome'>, deps: AuditPipelineDependencies) => {
  const outcome = createOperationOutcome({ model: input.operation.model, operation: input.operation.action }, {});
  const failures = failuresOf(deps);
  return runAuditedOperation(
    {
      ...input,
      outcome: {
        ...outcome,
        fail: (failure) => {
          failures.push(failure);
          outcome.fail(failure);
        },
      },
    },
    deps,
  );
};

const scopeSeenBy = (executor: OperationExecutor): ExecutionScope => {
  const call = vi.mocked(executor.run).mock.calls[0];
  if (!call) throw new Error('executor did not run');
  return call[1];
};

type KeptFailure = Extract<AuditFailure, { readonly phase: 'pre-fetch' | 'row-identification' }>;

const auditWriteOf = (deps: AuditPipelineDependencies) => vi.mocked(deps.dispatchConfig.writeExecutor.write);

describe('runAuditedOperation', () => {
  beforeEach(() => {
    clearPendingWrites();
  });

  describe('write plan and scope', () => {
    it('runs on the audited client without opening a transaction when the mode is awaited outside any transaction, and awaits the write', async () => {
      const auditedClient = createAuditedClient();
      const deps = createDeps();

      await runOperation(
        {
          operation: interceptedOf(),
          auditContext,
          auditedClient,
          mode: 'awaited',
          plan: 'awaited-after-commit',
          transaction: undefined,
        },
        deps,
      );

      expect(auditedClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(auditedClient);
      expect(scope.auditedClient).toBe(auditedClient);
      expect(scope.transaction).toBeUndefined();
      expect(getPendingWriteCount()).toBe(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(auditedClient, [record]);
    });

    it('runs on the transaction client and writes immediately in it when the mode is atomic inside a transaction', async () => {
      const auditedClient = createAuditedClient();
      const deps = createDeps();
      const transaction = activeTransactionOf(transactionClient);

      await runOperation(
        { operation: interceptedOf(), auditContext, auditedClient, mode: 'atomic', plan: 'immediate', transaction },
        deps,
      );

      expect(scopeSeenBy(deps.singleExecutor).handle).toBe(transactionClient);
      expect(auditWriteOf(deps)).toHaveBeenCalledWith(transactionClient, [record]);
    });

    it('runs on the audited client without a transaction when the mode is deferred, and detaches the write', async () => {
      const auditedClient = createAuditedClient();
      let finishWrite: () => void = () => {};
      const write = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      );
      const deps = createDeps();
      const dispatchConfig = { ...deps.dispatchConfig, writeExecutor: { write } };

      await runOperation(
        {
          operation: interceptedOf(),
          auditContext,
          auditedClient,
          mode: 'deferred',
          plan: 'detached',
          transaction: undefined,
        },
        { ...deps, dispatchConfig },
      );

      expect(auditedClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(auditedClient);
      expect(scope.transaction).toBeUndefined();
      expect(getPendingWriteCount()).toBe(1);
      finishWrite();
      await flushAllPendingWrites();
      expect(write).toHaveBeenCalledWith(auditedClient, [record]);
    });

    it('runs on the transaction client and writes immediately in it when the mode is deferred inside a transaction', async () => {
      const auditedClient = createAuditedClient();
      const deps = createDeps();
      const transaction = activeTransactionOf(transactionClient);

      await runOperation(
        { operation: interceptedOf(), auditContext, auditedClient, mode: 'deferred', plan: 'immediate', transaction },
        deps,
      );

      expect(auditedClient.transactionsOpened.count).toBe(0);
      const scope = scopeSeenBy(deps.singleExecutor);
      expect(scope.handle).toBe(transactionClient);
      expect(scope.transaction).toBe(transaction.audit);
      expect(getPendingWriteCount()).toBe(0);
      expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(transactionClient, [record]);
    });

    it.each([
      { mode: 'awaited', plan: 'awaited-after-commit' },
      { mode: 'deferred', plan: 'detached' },
    ] as const)(
      'runs an operation whose input names no transaction outside any, whatever transaction the surrounding scope is bound to, when the mode is $mode',
      async ({ mode, plan }) => {
        const auditedClient = createAuditedClient();
        const deps = createDeps();
        const surrounding = activeTransactionOf(transactionClientWith());

        await withScope({ binding: { transaction: surrounding } }, () =>
          runOperation(
            { operation: interceptedOf(), auditContext, auditedClient, mode, plan, transaction: undefined },
            deps,
          ),
        );
        await flushAllPendingWrites();

        const scope = scopeSeenBy(deps.singleExecutor);
        expect(scope.handle).toBe(auditedClient);
        expect(scope.transaction).toBeUndefined();
        expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(auditedClient, [record]);
      },
    );

    it('writes the audit of an operation by the transaction its input names, whatever transaction the surrounding scope is bound to', async () => {
      const auditedClient = createAuditedClient();
      const deps = createDeps();
      const named = activeTransactionOf(transactionClient);
      const surrounding = activeTransactionOf(transactionClientWith());

      await withScope({ binding: { transaction: surrounding } }, () =>
        runOperation(
          {
            operation: interceptedOf(),
            auditContext,
            auditedClient,
            mode: 'atomic',
            plan: 'immediate',
            transaction: named,
          },
          deps,
        ),
      );

      expect(scopeSeenBy(deps.singleExecutor).handle).toBe(named.client);
      expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(named.client, [record]);
    });
  });

  describe('continuation', () => {
    const runningTheOperation = () =>
      stubExecutor(async (operation) => {
        await operation.execute(operation.args);
        return executedUpdate;
      });

    type Run = (
      update: () => void,
      start: (auditedClient: PrismaBaseClient, transaction: ActiveTransaction | undefined) => Promise<unknown>,
    ) => Promise<unknown>;

    it.each<{ path: string; mode: WriteMode; plan: WritePlanKind; run: Run }>([
      {
        path: "inside the caller's own transaction",
        mode: 'atomic',
        plan: 'immediate',
        run: (update, start) =>
          start(createAuditedClient(), activeTransactionOf(transactionClientWith({ user: { update } }))),
      },
      {
        path: 'when the mode is deferred',
        mode: 'deferred',
        plan: 'detached',
        run: (update, start) => start(createAuditedClient(transactionClient, { user: { update } }), undefined),
      },
    ])(
      'continues the operation through query, never through the client delegate, $path',
      async ({ mode, plan, run }) => {
        const update = vi.fn();
        const deps = createDeps({ singleExecutor: runningTheOperation() });
        const operation = interceptedOf();

        await run(update, (auditedClient, transaction) =>
          runOperation({ operation, auditContext, auditedClient, mode, plan, transaction }, deps),
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
          flagSeen.push(['query', withinAudit()]);
        }),
      );
      const executor = stubExecutor(async (executed) => {
        flagSeen.push(['read before', withinAudit()]);
        await executed.execute(executed.args);
        flagSeen.push(['read after', withinAudit()]);
        return executedUpdate;
      });
      const deps = createDeps({ singleExecutor: executor });

      await withScope({ withinAudit: true }, () =>
        runOperation(
          {
            operation,
            auditContext,
            auditedClient: createAuditedClient(),
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
          runOperation(
            { operation, auditContext, auditedClient: createAuditedClient(), mode, plan, transaction: undefined },
            deps,
          ),
        ).rejects.toBe(callerError);

        expect(Object.getOwnPropertySymbols(callerError)).toEqual([]);
        expect(failuresOf(deps)).toEqual([]);
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
        runOperation(
          {
            operation,
            auditContext,
            auditedClient: createAuditedClient(),
            mode: 'deferred',
            plan: 'detached',
            transaction: undefined,
          },
          deps,
        ),
      ).rejects.toBe(value);

      expect(failuresOf(deps)).toEqual([]);
      expect(auditWriteOf(deps)).not.toHaveBeenCalled();
    });
  });

  describe('executor', () => {
    it('routes a batch action to the batch executor and any other action to the single executor', async () => {
      const deps = createDeps();
      const auditedClient = createAuditedClient();

      await runOperation(
        {
          operation: interceptedOf('updateMany'),
          auditContext,
          auditedClient,
          mode: 'awaited',
          plan: 'awaited-after-commit',
          transaction: undefined,
        },
        deps,
      );
      await runOperation(
        {
          operation: interceptedOf('upsert'),
          auditContext,
          auditedClient,
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

      const result = await runOperation(
        {
          operation: interceptedOf(),
          auditContext,
          auditedClient: createAuditedClient(),
          mode: 'awaited',
          plan: 'awaited-after-commit',
          transaction: undefined,
        },
        deps,
      );

      expect(result).toBe(executedUpdate.result);
      expect(failuresOf(deps)).toEqual([]);
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
          runOperation(
            {
              operation,
              auditContext,
              auditedClient: createAuditedClient(),
              mode: 'awaited',
              plan: 'awaited-after-commit',
              transaction: undefined,
            },
            deps,
          ),
        ).rejects.toBe(auditError);

        expect(failuresOf(deps)).toEqual([{ phase: 'diff-generation', error: auditError }]);
        expect(auditWriteOf(deps)).not.toHaveBeenCalled();
      },
    );

    describe('a failed build of the records after the write', () => {
      const buildError = new Error('read after the write failed');
      const failingBuildExecutor = () =>
        stubExecutor(async () => ({
          result: executedUpdate.result,
          buildRecords: async () => {
            throw buildError;
          },
        }));
      const buildFailure: AuditFailure = { phase: 'diff-generation', error: buildError };

      it.each([
        { mode: 'atomic', plan: 'immediate' },
        { mode: 'awaited', plan: 'immediate' },
        { mode: 'deferred', plan: 'immediate' },
      ] as const)(
        'rejects with the original error and records the failure on the transaction when the mode is $mode inside a transaction',
        async ({ mode, plan }) => {
          const deps = createDeps({ singleExecutor: failingBuildExecutor() });
          const transaction = activeTransactionOf(transactionClient);

          await expect(
            runOperation(
              {
                operation: interceptedOf(),
                auditContext,
                auditedClient: createAuditedClient(),
                mode,
                plan,
                transaction,
              },
              deps,
            ),
          ).rejects.toBe(buildError);

          expect(failuresOf(deps)).toEqual([buildFailure]);
          expect(recordedFailuresOf(transaction.audit)).toEqual([buildError]);
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
              runOperation(
                {
                  operation: interceptedOf(),
                  auditContext,
                  auditedClient: createAuditedClient(),
                  mode,
                  plan,
                  transaction: undefined,
                },
                deps,
              ),
            ),
          ).resolves.toBe(executedUpdate.result);

          expect(failuresOf(deps)).toEqual([buildFailure]);
          expect(recordedFailuresOf(surrounding.audit)).toEqual([]);
          expect(getPendingWriteCount()).toBe(0);
          expect(auditWriteOf(deps)).not.toHaveBeenCalled();
        },
      );
    });

    describe('a failed write of the records', () => {
      const writeError = new Error('DB write failed');
      const failingWriteDeps = () =>
        createDeps({
          dispatchConfig: {
            writeExecutor: {
              write: vi.fn(async () => {
                throw writeError;
              }),
            },
          },
        });

      it('lets a write failure inside a transaction propagate without reporting it as diff-generation, and records it on the transaction', async () => {
        const deps = failingWriteDeps();
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runOperation(
            {
              operation: interceptedOf(),
              auditContext,
              auditedClient: createAuditedClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(writeError);

        expect(failuresOf(deps)).toEqual([{ phase: 'log-write', records: [record], error: writeError }]);
        expect(recordedFailuresOf(transaction.audit)).toEqual([writeError]);
      });

      it('returns the result and records nothing when the write fails outside any transaction', async () => {
        const deps = failingWriteDeps();
        const surrounding = activeTransactionOf(transactionClientWith());

        await expect(
          withScope({ binding: { transaction: surrounding } }, () =>
            runOperation(
              {
                operation: interceptedOf(),
                auditContext,
                auditedClient: createAuditedClient(),
                mode: 'awaited',
                plan: 'awaited-after-commit',
                transaction: undefined,
              },
              deps,
            ),
          ),
        ).resolves.toBe(executedUpdate.result);

        expect(failuresOf(deps)).toEqual([{ phase: 'log-write', records: [record], error: writeError }]);
        expect(recordedFailuresOf(surrounding.audit)).toEqual([]);
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
          return executedUpdate;
        });
        const deps = createDeps({ singleExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runOperation(
            {
              operation: interceptedOf('update', failingQuery()),
              auditContext,
              auditedClient: createAuditedClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(mutationError);

        expect(recordedFailuresOf(transaction.audit)).toEqual([]);
      });

      it("records the caller's own mutation failure on the transaction when an earlier round of the operation wrote, and rethrows it untouched", async () => {
        const executor = stubExecutor(async (operation) => {
          await operation.execute(operation.args);
          await operation.execute(operation.args);
          return executedUpdate;
        });
        const query = vi
          .fn(async (): Promise<unknown> => 'written')
          .mockResolvedValueOnce('written')
          .mockRejectedValueOnce(mutationError);
        const deps = createDeps({ batchExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runOperation(
            {
              operation: interceptedOf('updateMany', query),
              auditContext,
              auditedClient: createAuditedClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(mutationError);

        expect(query).toHaveBeenCalledTimes(2);
        expect(failuresOf(deps)).toEqual([]);
        expect(recordedFailuresOf(transaction.audit)).toEqual([mutationError]);
      });

      it('does not record a failure before the write on the transaction', async () => {
        const executor = stubExecutor(async () => {
          throw executorError;
        });
        const query = vi.fn();
        const deps = createDeps({ singleExecutor: executor });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runOperation(
            {
              operation: interceptedOf('update', query),
              auditContext,
              auditedClient: createAuditedClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(executorError);

        expect(query).not.toHaveBeenCalled();
        expect(recordedFailuresOf(transaction.audit)).toEqual([]);
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
          runOperation(
            {
              operation: interceptedOf('update', query),
              auditContext,
              auditedClient: createAuditedClient(),
              mode: 'atomic',
              plan: 'immediate',
              transaction,
            },
            deps,
          ),
        ).rejects.toBe(executorError);

        expect(query).toHaveBeenCalledTimes(1);
        expect(failuresOf(deps)).toEqual([{ phase: 'diff-generation', error: executorError }]);
        expect(recordedFailuresOf(transaction.audit)).toEqual([executorError]);
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
            runOperation(
              {
                operation: interceptedOf(
                  'update',
                  vi.fn(async () => 'written'),
                ),
                auditContext,
                auditedClient: createAuditedClient(),
                mode: 'awaited',
                plan: 'awaited-after-commit',
                transaction: undefined,
              },
              deps,
            ),
          ),
        ).rejects.toBe(executorError);

        expect(recordedFailuresOf(surrounding.audit)).toEqual([]);
      });
    });

    describe('a failure kept for the operation', () => {
      const failureOf = (phase: 'pre-fetch' | 'row-identification', operation: string): KeptFailure =>
        phase === 'pre-fetch'
          ? { phase, modelName: 'User', operation, error: new Error(`${phase} failed`) }
          : { phase, modelName: 'User', operation, unidentified: 1, error: new Error(`${phase} failed`) };
      /** An executor that runs the write, then reports `failure` and the `unrecorded` writes to the scope's failure sink */
      const keepingExecutor = (failure: KeptFailure, unrecorded: readonly UnrecordedWrite[] = []) =>
        stubExecutor(async (operation, scope) => {
          await operation.execute(operation.args);
          scope.failureSink.fail(failure);
          for (const write of unrecorded) {
            scope.failureSink.reportUnrecordedWrite(write);
          }
          return executedUpdate;
        });

      it('rejects an atomic operation a row-identification failure dropped a record of, once its records are written, and records the rejection on the transaction', async () => {
        const failure = failureOf('row-identification', 'updateMany');
        const deps = createDeps({ batchExecutor: keepingExecutor(failure) });
        const transaction = activeTransactionOf(transactionClient);

        const run = runOperation(
          {
            operation: interceptedOf(
              'updateMany',
              vi.fn(async () => 'written'),
            ),
            auditContext,
            auditedClient: createAuditedClient(),
            mode: 'atomic',
            plan: 'immediate',
            transaction,
          },
          deps,
        );

        await expect(run).rejects.toBeInstanceOf(AuditIncompleteError);
        const rejection = await run.catch((error: unknown) => error);
        expect(rejection).toMatchObject({
          modelName: 'User',
          operation: 'updateMany',
          failures: [failure],
          unrecordedWrites: [],
        });
        expect((rejection as Error).cause).toEqual([failure]);
        expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(transactionClient, [record]);
        expect(recordedFailuresOf(transaction.audit)).toEqual([rejection]);
      });

      const atomicUpdateIn = (transaction: ActiveTransaction): Omit<AuditedOperationInput, 'outcome'> => ({
        operation: interceptedOf(
          'update',
          vi.fn(async () => 'written'),
        ),
        auditContext,
        auditedClient: createAuditedClient(),
        mode: 'atomic',
        plan: 'immediate',
        transaction,
      });
      const unrecordedUpsert: UnrecordedWrite = { modelName: 'Comment', operation: 'upsert', path: 'comments' };

      it('rejects an atomic operation the event collection left a write of without a record, with the pre-fetch failure kept for it as the cause', async () => {
        const failure = failureOf('pre-fetch', 'upsert');
        const deps = createDeps({ singleExecutor: keepingExecutor(failure, [unrecordedUpsert]) });
        const transaction = activeTransactionOf(transactionClient);

        const run = runOperation(atomicUpdateIn(transaction), deps);

        await expect(run).rejects.toBeInstanceOf(AuditIncompleteError);
        const rejection = await run.catch((error: unknown) => error);
        expect(rejection).toMatchObject({
          modelName: 'User',
          operation: 'update',
          failures: [failure],
          unrecordedWrites: [unrecordedUpsert],
        });
        expect(failuresOf(deps)).toEqual([failure]);
        expect(recordedFailuresOf(transaction.audit)).toEqual([rejection]);
      });

      it.each([
        {
          cause: 'a row-identification failure dropped a record of',
          operation: 'updateMany',
          deps: () => createDeps({ batchExecutor: keepingExecutor(failureOf('row-identification', 'updateMany')) }),
        },
        {
          cause: 'the event collection left a write of without a record',
          operation: 'update',
          deps: () =>
            createDeps({ singleExecutor: keepingExecutor(failureOf('pre-fetch', 'upsert'), [unrecordedUpsert]) }),
        },
      ] as const)('resolves an awaited operation $cause', async ({ operation, deps }) => {
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runOperation(
            {
              ...atomicUpdateIn(transaction),
              operation: interceptedOf(
                operation,
                vi.fn(async () => 'written'),
              ),
              mode: 'awaited',
            },
            deps(),
          ),
        ).resolves.toBe(executedUpdate.result);

        expect(recordedFailuresOf(transaction.audit)).toEqual([]);
      });

      it.each(['upsert', 'update'] as const)(
        'resolves an atomic operation a %s pre-fetch failure was kept for when the event collection left no write without a record',
        async (action) => {
          const deps = createDeps({ singleExecutor: keepingExecutor(failureOf('pre-fetch', action)) });
          const transaction = activeTransactionOf(transactionClient);

          await expect(runOperation(atomicUpdateIn(transaction), deps)).resolves.toBe(executedUpdate.result);

          expect(recordedFailuresOf(transaction.audit)).toEqual([]);
        },
      );

      it('keeps the failures of each operation apart from those of another it runs while continuing', async () => {
        const inner = createDeps({
          singleExecutor: keepingExecutor(failureOf('row-identification', 'update')),
        });
        const innerTransaction = activeTransactionOf(transactionClient);
        const outerQuery = vi.fn(async () => {
          await runOperation({ ...atomicUpdateIn(innerTransaction), mode: 'awaited' }, inner);
          return 'written';
        });
        const deps = createDeps({
          singleExecutor: stubExecutor(async (operation) => {
            await operation.execute(operation.args);
            return executedUpdate;
          }),
        });
        const transaction = activeTransactionOf(transactionClient);

        await expect(
          runOperation({ ...atomicUpdateIn(transaction), operation: interceptedOf('update', outerQuery) }, deps),
        ).resolves.toBe(executedUpdate.result);

        expect(outerQuery).toHaveBeenCalledTimes(1);
        expect(recordedFailuresOf(transaction.audit)).toEqual([]);
      });
    });
  });
});
