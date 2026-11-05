/**
 * Tests for dispatch: the records are built before it resolves, each write plan writes them on
 * the right handle at the right time (immediately and awaited in the transaction, awaited after
 * the commit outside any, or detached), every write mode inside a transaction writing
 * immediately, the writer hook receives where the write runs, the operation's outcome learns how
 * many records a writer took or why none were, a failed write reaches it as log-write and fails the
 * caller inside a transaction only, and a failed build is reported as diff-generation and fails the
 * caller inside a transaction only, the dropped records being reported without failing it outside
 * any.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchConfig, dispatch } from '../src/dispatch/index.js';
import { createActorId, createAggregateId, createEntityId } from '../src/domain/branded-types.js';
import type { AuditRecord } from '../src/domain/mutation-event.js';
import type { TransactionRuntime, WriteContext, WriteExecutor, WriteFn } from '../src/domain/write.js';
import type { AuditFailure, OperationOutcome } from '../src/outcome/index.js';
import { planFor, type WritePlanKind } from '../src/policy/index.js';
import type { AuditContext } from '../src/types.js';
import { deferred } from './support/deferred.js';
import { spiedTransactionAudit } from './support/spied-transaction-audit.js';

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
  const { audit, poison } = spiedTransactionAudit();
  const detached: Work[] = [];
  const detach = vi.fn((work: Work) => {
    detached.push(work);
  });
  const runtime: TransactionRuntime<Handle> = {
    baseHandle,
    transaction: inTransaction ? { handle: transactionHandle, audit } : undefined,
    detach,
  };
  return { runtime, poison, detach, detached };
};

const createConfig = (options: { write?: WriteExecutor<Handle>['write']; writer?: WriteFn<Handle> } = {}) => {
  const writeExecutor = { write: vi.fn(options.write ?? (async () => {})) };
  const config: DispatchConfig<Handle> = { writeExecutor, writer: options.writer };
  return { config, writeExecutor };
};

/** The outcome of the dispatched operation, keeping what `dispatch` reports to it */
const createOutcome = () => {
  const failures: AuditFailure[] = [];
  const finished: number[] = [];
  const outcome: Pick<OperationOutcome, 'fail' | 'writeFinished'> = {
    fail: vi.fn((failure) => {
      failures.push(failure);
    }),
    writeFinished: vi.fn(async (written: number) => {
      finished.push(written);
    }),
  };
  return { outcome, failures, finished };
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

const logWriteFailure: AuditFailure = { phase: 'log-write', records, error: writeError };

const audited = (
  plan: WritePlanKind,
  outcome: Pick<OperationOutcome, 'fail' | 'writeFinished'> = createOutcome().outcome,
  buildRecords: () => Promise<readonly AuditRecord[]> = async () => records,
) => ({
  buildRecords,
  plan,
  auditContext,
  outcome,
});

const buildError = new Error('read after the write failed');
const failingBuild = async (): Promise<readonly AuditRecord[]> => {
  throw buildError;
};
const buildFailure: AuditFailure = { phase: 'diff-generation', error: buildError };

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

  describe('immediately, for an immediate plan', () => {
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
      const { runtime, detach } = createRuntime(true);

      const dispatched = dispatch(audited('immediate'), config, runtime).then(() => {
        events.push('dispatch resolved');
      });
      await runPendingContinuations();

      expect(writeExecutor.write).toHaveBeenCalledWith(transactionHandle, [record]);
      expect(events).toEqual([]);
      writeReleased.resolve();
      await dispatched;
      expect(events).toEqual(['write finished', 'dispatch resolved']);
      expect(detach).not.toHaveBeenCalled();
    });

    it('tells the outcome the number of records the writer took once the write has finished', async () => {
      const { outcome, finished, failures } = createOutcome();
      const { config } = createConfig();

      await dispatch(audited('immediate', outcome), config, createRuntime(true).runtime);

      expect(finished).toEqual([1]);
      expect(failures).toEqual([]);
    });

    it('rejects with the original error after reporting the failed write as log-write, which carries the records by reference', async () => {
      const { outcome, finished, failures } = createOutcome();
      const { config } = createConfig({ write: failingWrite });

      await expect(dispatch(audited('immediate', outcome), config, createRuntime(true).runtime)).rejects.toBe(
        writeError,
      );

      expect(failures).toEqual([logWriteFailure]);
      expect(failures[0]?.phase === 'log-write' && failures[0].records).toBe(records);
      expect(finished).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('records the failed write on the transaction, which must then not commit', async () => {
      const { config } = createConfig({ write: failingWrite });
      const { runtime, poison } = createRuntime(true);

      await expect(dispatch(audited('immediate'), config, runtime)).rejects.toBe(writeError);

      expect(poison.mock.calls).toEqual([[writeError]]);
    });
  });

  it.each(['atomic', 'awaited', 'deferred'] as const)(
    'writes the records of a %s operation inside a transaction on the transaction handle, awaited',
    async (mode) => {
      const { outcome, finished } = createOutcome();
      const { config, writeExecutor } = createConfig();
      const { runtime, detach } = createRuntime(true);
      const plan = planFor(mode, true);
      if (plan === 'reject') {
        throw new Error(`a ${mode} operation inside a transaction is not rejected`);
      }

      await dispatch(audited(plan, outcome), config, runtime);

      expect(writeExecutor.write).toHaveBeenCalledWith(transactionHandle, [record]);
      expect(finished).toEqual([1]);
      expect(detach).not.toHaveBeenCalled();
    },
  );

  describe('detached, for a detached plan outside any transaction', () => {
    it('hands one work to detach and writes nothing until it runs, then writes on the base handle', async () => {
      const { config, writeExecutor } = createConfig();
      const { runtime, detach, detached } = createRuntime(false);

      await dispatch(audited('detached'), config, runtime);

      expect(detach).toHaveBeenCalledTimes(1);
      expect(writeExecutor.write).not.toHaveBeenCalled();

      await runAll(detached);

      expect(writeExecutor.write).toHaveBeenCalledWith(baseHandle, [record]);
    });

    it('reports a failure of the detached work as log-write, wrapping a non-Error rejection in an Error', async () => {
      const { outcome, failures } = createOutcome();
      const { config } = createConfig({ write: () => Promise.reject('insert failed') });
      const { runtime, detached } = createRuntime(false);

      await dispatch(audited('detached', outcome), config, runtime);
      await runAll(detached);

      expect(failures).toEqual([{ phase: 'log-write', records, error: expect.any(Error) }]);
      expect(failures[0]?.error.message).toBe('insert failed');
    });

    it('never rejects from the detached work, telling the outcome no record was taken', async () => {
      const { outcome, failures, finished } = createOutcome();
      const { config } = createConfig({ write: failingWrite });
      const { runtime, detached } = createRuntime(false);

      await dispatch(audited('detached', outcome), config, runtime);

      await expect(detached[0]?.()).resolves.toBeUndefined();
      expect(failures).toEqual([logWriteFailure]);
      expect(finished).toEqual([0]);
    });
  });

  describe('the writer hook', () => {
    it.each([
      { plan: 'immediate', inTransaction: true, handle: transactionHandle },
      { plan: 'awaited-after-commit', inTransaction: false, handle: baseHandle },
      { plan: 'detached', inTransaction: false, handle: baseHandle },
    ] as const)(
      'receives the audit context, the handle the write runs on, whether it is the transaction handle and a default write on it ($plan)',
      async ({ plan, inTransaction, handle }) => {
        const writer = vi.fn(async (written: AuditRecord[], { defaultWrite }: WriteContext<Handle>) =>
          defaultWrite(written),
        );
        const { config, writeExecutor } = createConfig({ writer });
        const { runtime, detached } = createRuntime(inTransaction);

        await dispatch(audited(plan), config, runtime);
        await runAll(detached);

        expect(writer).toHaveBeenCalledWith([record], {
          auditContext,
          handle,
          inTransaction,
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

      await dispatch(audited('immediate'), config, createRuntime(true).runtime);

      expect(writeExecutor.write).toHaveBeenCalledTimes(1);
      expect(writeExecutor.write).toHaveBeenCalledWith(transactionHandle, [changed]);
    });

    it('reports a writer failure like a failed default write', async () => {
      const writer = vi.fn(failingWrite);
      const { outcome, failures } = createOutcome();
      const { config, writeExecutor } = createConfig({ writer });

      await dispatch(audited('awaited-after-commit', outcome), config, createRuntime(false).runtime);

      expect(writeExecutor.write).not.toHaveBeenCalled();
      expect(failures).toEqual([logWriteFailure]);
    });
  });

  it('rejects an immediate plan outside any transaction before building or writing anything', async () => {
    const buildRecords = vi.fn(async () => records);
    const { config, writeExecutor } = createConfig();

    await expect(
      dispatch(audited('immediate', createOutcome().outcome, buildRecords), config, createRuntime(false).runtime),
    ).rejects.toThrow("The immediate write plan needs the operation's transaction, and the operation runs outside any");
    expect(buildRecords).not.toHaveBeenCalled();
    expect(writeExecutor.write).not.toHaveBeenCalled();
  });

  it('reports every record of a failed write even when the writer emptied the array it was given', async () => {
    const built = [record];
    const writer = vi.fn(async (received: AuditRecord[]) => {
      received.length = 0;
      throw writeError;
    });
    const { outcome, failures } = createOutcome();
    const { config } = createConfig({ writer });

    await expect(
      dispatch(
        audited('immediate', outcome, async () => built),
        config,
        createRuntime(true).runtime,
      ),
    ).rejects.toBe(writeError);

    expect(failures).toEqual([{ phase: 'log-write', records: [record], error: writeError }]);
  });

  it.each([
    { plan: 'immediate', inTransaction: true },
    { plan: 'detached', inTransaction: false },
  ] as const)(
    'writes and detaches nothing without records, telling the outcome so ($plan)',
    async ({ plan, inTransaction }) => {
      const { outcome, finished } = createOutcome();
      const { config, writeExecutor } = createConfig();
      const { runtime, detach } = createRuntime(inTransaction);

      await dispatch(
        audited(plan, outcome, async () => []),
        config,
        runtime,
      );

      expect(finished).toEqual([0]);
      expect(writeExecutor.write).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    },
  );
  describe('after the write has committed and awaited, for an awaited-after-commit plan outside any transaction', () => {
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

      const dispatched = dispatch(audited('awaited-after-commit'), config, runtime).then(() => {
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

    it("reports a failed write as log-write and resolves, telling the outcome no record was taken, since the operation's write has committed", async () => {
      const { outcome, failures, finished } = createOutcome();
      const { config } = createConfig({ write: failingWrite });

      await expect(
        dispatch(audited('awaited-after-commit', outcome), config, createRuntime(false).runtime),
      ).resolves.toBeUndefined();

      expect(failures).toEqual([logWriteFailure]);
      expect(finished).toEqual([0]);
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe('a record build that fails', () => {
    it('reports diff-generation once and rejects with its error, writing nothing (immediate)', async () => {
      const { outcome, failures, finished } = createOutcome();
      const { config, writeExecutor } = createConfig();
      const { runtime, poison, detach } = createRuntime(true);

      await expect(dispatch(audited('immediate', outcome, failingBuild), config, runtime)).rejects.toBe(buildError);

      expect(poison.mock.calls).toEqual([[buildError]]);
      expect(failures).toEqual([buildFailure]);
      expect(finished).toEqual([]);
      expect(writeExecutor.write).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    });

    it.each([{ plan: 'detached' }, { plan: 'awaited-after-commit' }] as const)(
      'reports diff-generation once and resolves, dropping the records, outside any transaction, whose operation has committed ($plan)',
      async ({ plan }) => {
        const { outcome, failures, finished } = createOutcome();
        const { config, writeExecutor } = createConfig();
        const { runtime, detach } = createRuntime(false);

        await expect(dispatch(audited(plan, outcome, failingBuild), config, runtime)).resolves.toBeUndefined();

        expect(failures).toEqual([buildFailure]);
        expect(finished).toEqual([0]);
        expect(detach).not.toHaveBeenCalled();
        expect(writeExecutor.write).not.toHaveBeenCalled();
      },
    );

    it('wraps a non-Error rejection in an Error', async () => {
      const { outcome, failures } = createOutcome();
      const { config } = createConfig();

      await dispatch(
        audited('detached', outcome, () => Promise.reject('read failed')),
        config,
        createRuntime(false).runtime,
      );

      expect(failures).toEqual([{ phase: 'diff-generation', error: expect.any(Error) }]);
      expect(failures[0]?.error.message).toBe('read failed');
    });
  });

  it.each([
    { plan: 'immediate', inTransaction: true },
    { plan: 'detached', inTransaction: false },
  ] as const)(
    'builds the records once before it resolves, ahead of any work it hands over ($plan)',
    async ({ plan, inTransaction }) => {
      const buildRecords = vi.fn(async () => records);
      const { config } = createConfig();
      const { runtime, detach } = createRuntime(inTransaction);

      await dispatch(audited(plan, createOutcome().outcome, buildRecords), config, runtime);

      expect(buildRecords).toHaveBeenCalledTimes(1);
      for (const order of detach.mock.invocationCallOrder) {
        expect(order).toBeGreaterThan(buildRecords.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
      }
    },
  );
});
