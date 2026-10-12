/**
 * Tests for dispatch: the records are built before it resolves, each policy and transaction state
 * writes them on the right handle at the right time (immediately and awaited, after commit, or
 * detached), the writer hook receives where the write runs, a failed write reaches the failure sink
 * with the write plan it belongs to, and a failed build is reported as diff-generation and fails
 * the caller unless the write would be detached, where the dropped records follow the write-failure
 * policy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchConfig, dispatch } from '../src/dispatch/index.js';
import { createActorId, createAggregateId, createEntityId } from '../src/domain/branded-types.js';
import type { AuditRecord } from '../src/domain/mutation-event.js';
import type { TransactionRuntime, WriteContext, WriteExecutor, WriteFn } from '../src/domain/write.js';
import { type AuditErrorContext, createFailureSink, type FailureSink } from '../src/failure/index.js';
import type { AuditContext } from '../src/types.js';
import { deferred } from './support/deferred.js';

interface Handle {
  readonly name: string;
}

const baseHandle: Handle = { name: 'base' };
const transactionHandle: Handle = { name: 'transaction' };
const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

const record: AuditRecord = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'Post',
  entityId: createEntityId('post-1'),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'Post',
  aggregateId: createAggregateId('post-1'),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 'post-1' },
  changes: null,
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};
const records: readonly AuditRecord[] = [record];

type Work = () => Promise<void>;

/** A runtime that keeps the work handed to it instead of starting it */
const createRuntime = (inTransaction: boolean) => {
  const afterCommitted: Work[] = [];
  const detached: Work[] = [];
  const afterCommit = vi.fn((work: Work) => {
    afterCommitted.push(work);
  });
  const detach = vi.fn((work: Work) => {
    detached.push(work);
  });
  const runtime: TransactionRuntime<Handle> = {
    baseHandle,
    transaction: inTransaction ? { handle: transactionHandle, afterCommit } : undefined,
    detach,
  };
  return { runtime, afterCommit, detach, afterCommitted, detached };
};

const createSink = (): FailureSink => ({
  notify: vi.fn(async () => {}),
  reportResolverFailures: vi.fn(async () => {}),
  reportDroppedBuild: vi.fn(async () => {}),
  reportWriteFailure: vi.fn(async () => {}),
});

const createConfig = (
  options: { write?: WriteExecutor<Handle>['write']; writer?: WriteFn<Handle>; failureSink?: FailureSink } = {},
) => {
  const writeExecutor = { write: vi.fn(options.write ?? (async () => {})) };
  const failureSink = options.failureSink ?? createSink();
  const config: DispatchConfig<Handle> = { writeExecutor, writer: options.writer, failureSink };
  return { config, writeExecutor, failureSink };
};

const runAll = async (works: readonly Work[]): Promise<void> => {
  for (const work of works) {
    await work();
  }
};

const writeError = new Error('insert failed');
const failingWrite = async (): Promise<void> => {
  throw writeError;
};

/** The sink a user's 'throw' policy builds, with an observer that keeps every context */
const throwingPolicySink = () => {
  const observed: AuditErrorContext[] = [];
  const failureSink = createFailureSink({
    writeFailurePolicy: 'throw',
    observer: (context) => {
      observed.push(context);
    },
  });
  return { failureSink, observed };
};

const logWriteContext: AuditErrorContext = {
  phase: 'log-write',
  modelName: 'Post',
  operation: 'write',
  params: records,
  error: writeError,
};

/** How a failure report names the dispatched operation */
const operationFacts = { modelName: 'Post', operation: 'create', params: { id: 'post-1' } };

const audited = (atomic: boolean, buildRecords: () => Promise<readonly AuditRecord[]> = async () => records) => ({
  buildRecords,
  ...operationFacts,
  atomic,
  auditContext,
});

const buildError = new Error('read after the write failed');
const failingBuild = async (): Promise<readonly AuditRecord[]> => {
  throw buildError;
};
const buildFailureContext = { phase: 'diff-generation', ...operationFacts, error: buildError };

/**
 * Runs every continuation that can run, including the ones those queue in turn: a turn of the fake
 * clock yields to the event loop, which takes its next task only once the microtask queue is empty
 */
const runPendingContinuations = () => vi.advanceTimersByTimeAsync(0);

describe('dispatch', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.useRealTimers();
  });

  describe('immediately, for an atomic policy', () => {
    it('writes the records on the transaction handle and resolves only once the write has finished', async () => {
      vi.useFakeTimers();
      const writeReleased = deferred();
      const events: string[] = [];
      const { config, writeExecutor } = createConfig({
        write: async () => {
          await writeReleased.promise;
          events.push('write finished');
        },
      });
      const { runtime, afterCommit, detach } = createRuntime(true);

      const dispatched = dispatch(audited(true), config, runtime).then(() => {
        events.push('dispatch resolved');
      });
      await runPendingContinuations();

      expect(writeExecutor.write).toHaveBeenCalledWith(transactionHandle, [record]);
      expect(events).toEqual([]);
      writeReleased.resolve();
      await dispatched;
      expect(events).toEqual(['write finished', 'dispatch resolved']);
      expect(afterCommit).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    });

    it('reports a failed write with its immediate plan, which carries the records by reference', async () => {
      const { config, failureSink } = createConfig({ write: failingWrite });

      await dispatch(audited(true), config, createRuntime(true).runtime);

      expect(failureSink.reportWriteFailure).toHaveBeenCalledWith({ kind: 'immediate', records }, writeError);
      expect(vi.mocked(failureSink.reportWriteFailure).mock.calls[0]?.[0].records).toBe(records);
    });

    it("rejects with the original error under a 'throw' policy, after notifying the observer", async () => {
      const { failureSink, observed } = throwingPolicySink();
      const { config } = createConfig({ write: failingWrite, failureSink });

      await expect(dispatch(audited(true), config, createRuntime(true).runtime)).rejects.toBe(writeError);
      expect(observed).toEqual([logWriteContext]);
    });

    it("resolves under the default 'log' policy", async () => {
      const { config } = createConfig({ write: failingWrite, failureSink: createFailureSink({}) });

      await expect(dispatch(audited(true), config, createRuntime(true).runtime)).resolves.toBeUndefined();
    });
  });

  describe('after commit, for a non-atomic policy inside a transaction', () => {
    it('registers one work with the transaction and writes nothing until it runs, then writes on the base handle', async () => {
      const { config, writeExecutor } = createConfig();
      const { runtime, afterCommit, detach, afterCommitted } = createRuntime(true);

      await dispatch(audited(false), config, runtime);

      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(detach).not.toHaveBeenCalled();
      expect(writeExecutor.write).not.toHaveBeenCalled();

      await runAll(afterCommitted);

      expect(writeExecutor.write).toHaveBeenCalledWith(baseHandle, [record]);
    });

    it('reports a failure of the registered work with its after-commit plan once it runs', async () => {
      const { config, failureSink } = createConfig({ write: failingWrite });
      const { runtime, afterCommitted } = createRuntime(true);

      await dispatch(audited(false), config, runtime);
      expect(failureSink.reportWriteFailure).not.toHaveBeenCalled();
      await runAll(afterCommitted);

      expect(failureSink.reportWriteFailure).toHaveBeenCalledWith({ kind: 'after-commit', records }, writeError);
    });

    it("never rejects from the registered work, even under a 'throw' policy", async () => {
      const { failureSink, observed } = throwingPolicySink();
      const { config } = createConfig({ write: failingWrite, failureSink });
      const { runtime, afterCommitted } = createRuntime(true);

      await dispatch(audited(false), config, runtime);

      await expect(afterCommitted[0]?.()).resolves.toBeUndefined();
      expect(observed).toEqual([logWriteContext]);
    });
  });

  describe('detached, for a non-atomic policy outside any transaction', () => {
    it('hands one work to detach and writes nothing until it runs, then writes on the base handle', async () => {
      const { config, writeExecutor } = createConfig();
      const { runtime, detach, detached } = createRuntime(false);

      await dispatch(audited(false), config, runtime);

      expect(detach).toHaveBeenCalledTimes(1);
      expect(writeExecutor.write).not.toHaveBeenCalled();

      await runAll(detached);

      expect(writeExecutor.write).toHaveBeenCalledWith(baseHandle, [record]);
    });

    it('reports a failure of the detached work with its detached plan, wrapping a non-Error rejection in an Error', async () => {
      const { config, failureSink } = createConfig({ write: () => Promise.reject('insert failed') });
      const { runtime, detached } = createRuntime(false);

      await dispatch(audited(false), config, runtime);
      await runAll(detached);

      expect(failureSink.reportWriteFailure).toHaveBeenCalledWith({ kind: 'detached', records }, expect.any(Error));
      expect(vi.mocked(failureSink.reportWriteFailure).mock.calls[0]?.[1]?.message).toBe('insert failed');
    });

    it("never rejects from the detached work, even under a 'throw' policy", async () => {
      const { failureSink, observed } = throwingPolicySink();
      const { config } = createConfig({ write: failingWrite, failureSink });
      const { runtime, detached } = createRuntime(false);

      await dispatch(audited(false), config, runtime);

      await expect(detached[0]?.()).resolves.toBeUndefined();
      expect(observed).toEqual([logWriteContext]);
    });
  });

  describe('the writer hook', () => {
    it.each([
      { plan: 'immediate inside a transaction', atomic: true, inTransaction: true, handle: transactionHandle },
      { plan: 'immediate outside any transaction', atomic: true, inTransaction: false, handle: baseHandle },
      { plan: 'after commit', atomic: false, inTransaction: true, handle: baseHandle },
      { plan: 'detached', atomic: false, inTransaction: false, handle: baseHandle },
    ])(
      'receives the audit context, the handle the write runs on, whether it is the transaction handle and a default write on it ($plan)',
      async ({ atomic, inTransaction, handle }) => {
        const writer = vi.fn(async (written: AuditRecord[], { defaultWrite }: WriteContext<Handle>) =>
          defaultWrite(written),
        );
        const { config, writeExecutor } = createConfig({ writer });
        const { runtime, afterCommitted, detached } = createRuntime(inTransaction);

        await dispatch(audited(atomic), config, runtime);
        await runAll([...afterCommitted, ...detached]);

        expect(writer).toHaveBeenCalledWith([record], {
          auditContext,
          handle,
          inTransaction: atomic && inTransaction,
          defaultWrite: expect.any(Function),
        });
        expect(writeExecutor.write).toHaveBeenCalledWith(handle, [record]);
      },
    );

    it('runs in place of the default write, whose defaultWrite writes the records it is given on the same handle', async () => {
      const changed: AuditRecord = { ...record, actorContext: { source: 'hook' } };
      const writer = vi.fn(async (_records: AuditRecord[], { defaultWrite }: WriteContext<Handle>) =>
        defaultWrite([changed]),
      );
      const { config, writeExecutor } = createConfig({ writer });

      await dispatch(audited(true), config, createRuntime(true).runtime);

      expect(writeExecutor.write).toHaveBeenCalledTimes(1);
      expect(writeExecutor.write).toHaveBeenCalledWith(transactionHandle, [changed]);
    });

    it('reports a writer failure like a failed default write', async () => {
      const writer = vi.fn(failingWrite);
      const { config, writeExecutor, failureSink } = createConfig({ writer });

      await dispatch(audited(true), config, createRuntime(true).runtime);

      expect(writeExecutor.write).not.toHaveBeenCalled();
      expect(failureSink.reportWriteFailure).toHaveBeenCalledWith({ kind: 'immediate', records }, writeError);
    });
  });

  it('hands the executor a copy of the records', async () => {
    const { config, writeExecutor } = createConfig();

    await dispatch(audited(true), config, createRuntime(true).runtime);

    const written = writeExecutor.write.mock.calls[0]?.[1];
    expect(written).toEqual([record]);
    expect(written).not.toBe(records);
  });

  it.each([
    { plan: 'immediate', atomic: true, inTransaction: true },
    { plan: 'after commit', atomic: false, inTransaction: true },
    { plan: 'detached', atomic: false, inTransaction: false },
  ])('writes, registers and detaches nothing without records ($plan)', async ({ atomic, inTransaction }) => {
    const { config, writeExecutor } = createConfig();
    const { runtime, afterCommit, detach } = createRuntime(inTransaction);

    await dispatch(
      audited(atomic, async () => []),
      config,
      runtime,
    );

    expect(writeExecutor.write).not.toHaveBeenCalled();
    expect(afterCommit).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });
  describe('after the write has committed and awaited, for an atomic policy outside any transaction', () => {
    it('writes on the base handle, outside any transaction, and resolves only once the write has finished', async () => {
      vi.useFakeTimers();
      const writeReleased = deferred();
      const events: string[] = [];
      const contexts: Array<{ readonly handle: Handle; readonly inTransaction: boolean }> = [];
      const { config } = createConfig({
        writer: async (written, { handle, inTransaction, defaultWrite }) => {
          contexts.push({ handle, inTransaction });
          await writeReleased.promise;
          await defaultWrite(written);
          events.push('write finished');
        },
      });
      const { runtime, detach } = createRuntime(false);

      const dispatched = dispatch(audited(true), config, runtime).then(() => {
        events.push('dispatch resolved');
      });
      await runPendingContinuations();

      expect(contexts).toEqual([{ handle: baseHandle, inTransaction: false }]);
      expect(events).toEqual([]);
      writeReleased.resolve();
      await dispatched;
      expect(events).toEqual(['write finished', 'dispatch resolved']);
      expect(detach).not.toHaveBeenCalled();
    });

    it('reports a failed write with its awaited-after-commit plan', async () => {
      const { config, failureSink } = createConfig({ write: failingWrite });

      await dispatch(audited(true), config, createRuntime(false).runtime);

      expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
        { kind: 'awaited-after-commit', records },
        writeError,
      );
    });

    it("resolves under a 'throw' policy, after notifying the observer, since the operation's write has committed", async () => {
      const { failureSink, observed } = throwingPolicySink();
      const { config } = createConfig({ write: failingWrite, failureSink });

      await expect(dispatch(audited(true), config, createRuntime(false).runtime)).resolves.toBeUndefined();
      expect(observed).toEqual([logWriteContext]);
      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] Error in audit log write after commit:',
        writeError.message,
      );
    });
  });

  describe('a record build that fails', () => {
    it.each([
      { plan: 'immediate inside a transaction', atomic: true },
      { plan: 'after commit inside a transaction', atomic: false },
    ])(
      'notifies diff-generation once, rejects with its error, reports no dropped build and writes and registers nothing ($plan)',
      async ({ atomic }) => {
        const { config, writeExecutor, failureSink } = createConfig();
        const { runtime, afterCommit, detach } = createRuntime(true);

        await expect(dispatch(audited(atomic, failingBuild), config, runtime)).rejects.toBe(buildError);

        expect(failureSink.notify).toHaveBeenCalledTimes(1);
        expect(failureSink.notify).toHaveBeenCalledWith(buildFailureContext);
        expect(failureSink.reportDroppedBuild).not.toHaveBeenCalled();
        expect(writeExecutor.write).not.toHaveBeenCalled();
        expect(failureSink.reportWriteFailure).not.toHaveBeenCalled();
        expect(afterCommit).not.toHaveBeenCalled();
        expect(detach).not.toHaveBeenCalled();
      },
    );

    it.each([
      { plan: 'detached', atomic: false },
      { plan: 'awaited after commit', atomic: true },
    ])(
      'reports the dropped build once and resolves, writing and detaching nothing, outside any transaction, whose operation has committed ($plan)',
      async ({ atomic }) => {
        const { config, writeExecutor, failureSink } = createConfig();
        const { runtime, detach } = createRuntime(false);

        await expect(dispatch(audited(atomic, failingBuild), config, runtime)).resolves.toBeUndefined();

        expect(failureSink.reportDroppedBuild).toHaveBeenCalledTimes(1);
        expect(failureSink.reportDroppedBuild).toHaveBeenCalledWith(buildFailureContext);
        expect(failureSink.notify).not.toHaveBeenCalled();
        expect(detach).not.toHaveBeenCalled();
        expect(writeExecutor.write).not.toHaveBeenCalled();
        expect(failureSink.reportWriteFailure).not.toHaveBeenCalled();
      },
    );

    it('wraps a non-Error rejection in an Error', async () => {
      const { config, failureSink } = createConfig();

      await dispatch(
        audited(false, () => Promise.reject('read failed')),
        config,
        createRuntime(false).runtime,
      );

      expect(failureSink.reportDroppedBuild).toHaveBeenCalledWith({ ...buildFailureContext, error: expect.any(Error) });
      expect(vi.mocked(failureSink.reportDroppedBuild).mock.calls[0]?.[0].error.message).toBe('read failed');
    });
  });

  it.each([
    { plan: 'immediate', atomic: true, inTransaction: true },
    { plan: 'after commit', atomic: false, inTransaction: true },
    { plan: 'detached', atomic: false, inTransaction: false },
  ])(
    'builds the records once before it resolves, ahead of any work it hands over ($plan)',
    async ({ atomic, inTransaction }) => {
      const buildRecords = vi.fn(async () => records);
      const { config } = createConfig();
      const { runtime, afterCommit, detach } = createRuntime(inTransaction);

      await dispatch(audited(atomic, buildRecords), config, runtime);

      expect(buildRecords).toHaveBeenCalledTimes(1);
      for (const handOver of [afterCommit, detach]) {
        for (const order of handOver.mock.invocationCallOrder) {
          expect(order).toBeGreaterThan(buildRecords.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
        }
      }
    },
  );
});
