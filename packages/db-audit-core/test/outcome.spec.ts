import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../src/domain/branded-types.js';
import type { AuditRecord, MutationEvent } from '../src/domain/mutation-event.js';
import {
  type AuditFailure,
  AuditIncompleteError,
  type AuditOutcome,
  createOperationOutcome,
  createTransactionOutcomes,
  type OperationOutcome,
  type UnrecordedWrite,
} from '../src/outcome/index.js';
import type { ResolverFailure } from '../src/resolve/index.js';
import { deferred } from './support/deferred.js';

const record: AuditRecord = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('u1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'Post',
  entityId: createEntityId('p1'),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'Post',
  aggregateId: createAggregateId('p1'),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 'p1' },
  changes: null,
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const target = { model: 'Post', operation: 'update' } as const;

const preFetchFailure: AuditFailure = {
  phase: 'pre-fetch',
  modelName: 'Post',
  operation: 'update',
  error: new Error('read failed'),
};
const rowIdentificationFailure: AuditFailure = {
  phase: 'row-identification',
  modelName: 'Post',
  operation: 'updateMany',
  unidentified: 2,
  error: new Error('2 rows not identified'),
};
const unrecordedWrite: UnrecordedWrite = { modelName: 'Tag', operation: 'connectOrCreate', path: 'tags' };

const outcomeOf = (overrides: Partial<AuditOutcome>): AuditOutcome =>
  ({
    model: 'Post',
    operation: 'update',
    status: 'complete',
    records: 0,
    failures: [],
    unrecordedWrites: [],
    ...overrides,
  }) as AuditOutcome;

describe('createOperationOutcome', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('status', () => {
    it('is complete for a committed operation whose records the writer took, with the number of records', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      await outcome.writeFinished(3);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'complete', records: 3 })]]);
    });

    it('is complete for a committed operation that produced no record', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      await outcome.writeFinished(0);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'complete', records: 0 })]]);
    });

    it('is complete with a pre-fetch failure that only left a record without its before state', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      outcome.fail(preFetchFailure);
      await outcome.writeFinished(1);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([
        [outcomeOf({ status: 'complete', records: 1, failures: [preFetchFailure] })],
      ]);
    });

    it.each<[string, Parameters<OperationOutcome['fail']>[0]]>([
      ['row-identification', rowIdentificationFailure],
      ['diff-generation', { phase: 'diff-generation', error: new Error('build failed') }],
      ['log-write', { phase: 'log-write', records: [record], error: new Error('insert failed') }],
    ])('is incomplete for a committed operation with a %s failure, which drops records', async (_phase, failure) => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      outcome.fail(failure);
      await outcome.writeFinished(0);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'incomplete', failures: [failure] })]]);
    });

    it('is incomplete for a committed operation that left a write without a record, carrying the write', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      outcome.fail(preFetchFailure);
      outcome.reportUnrecordedWrite(unrecordedWrite);
      await outcome.writeFinished(1);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([
        [
          outcomeOf({
            status: 'incomplete',
            records: 1,
            failures: [preFetchFailure],
            unrecordedWrites: [unrecordedWrite],
          }),
        ],
      ]);
    });

    it('is incomplete for a committed operation an id resolver failed for, with one failure per row and resolver', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });
      const event: MutationEvent = {
        model: 'Comment',
        identity: 'c1',
        action: 'create',
        before: { kind: 'none' },
        after: { id: 'c1' },
        origin: { path: 'comments', op: 'create' },
      };
      const entityError = new Error('id resolver failed');
      const aggregateError = new Error('root resolver failed');
      const failures: ResolverFailure[] = [
        { event, resolver: { kind: 'entity' }, error: entityError },
        {
          event,
          resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' },
          error: aggregateError,
        },
      ];

      outcome.reportResolverFailures(failures);
      await outcome.writeFinished(0);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([
        [
          outcomeOf({
            status: 'incomplete',
            failures: [
              {
                phase: 'id-resolver-call',
                modelName: 'Comment',
                operation: 'create',
                identity: 'c1',
                resolver: { kind: 'entity' },
                error: entityError,
              },
              {
                phase: 'id-resolver-call',
                modelName: 'Comment',
                operation: 'create',
                identity: 'c1',
                resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' },
                error: aggregateError,
              },
            ],
          }),
        ],
      ]);
    });

    it('is not-committed for an operation that did not commit, whatever its records, without waiting for their write', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      outcome.fail(rowIdentificationFailure);
      await outcome.settle('not-committed');

      expect(observer.mock.calls).toEqual([
        [outcomeOf({ status: 'not-committed', failures: [rowIdentificationFailure] })],
      ]);
    });

    it('is not-committed for a rolled-back operation whose records the writer took, keeping their number', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      await outcome.writeFinished(2);
      await outcome.settle('not-committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'not-committed', records: 2 })]]);
    });

    it('is unaudited with its reason for an operation run without an audit context, once it commits', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome({ ...target, unaudited: 'no-context' }, { observer });

      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'unaudited', unauditedReason: 'no-context' })]]);
    });

    it('is not-committed for an operation run without an audit context that did not commit', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome({ ...target, unaudited: 'no-context' }, { observer });

      await outcome.settle('not-committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'not-committed' })]]);
    });
  });

  describe('when the observer is called', () => {
    it('waits for a write that finishes after the operation committed, and calls the observer from it', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      await outcome.settle('committed');
      expect(observer).not.toHaveBeenCalled();

      await outcome.writeFinished(1);
      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'complete', records: 1 })]]);
    });

    it('waits for the commit of an operation whose write finished first', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      await outcome.writeFinished(1);
      expect(observer).not.toHaveBeenCalled();

      await outcome.settle('committed');
      expect(observer).toHaveBeenCalledTimes(1);
    });

    it('calls the observer once, ignoring a write that finishes after the operation was settled as not committed', async () => {
      const observer = vi.fn();
      const outcome = createOperationOutcome(target, { observer });

      await outcome.settle('not-committed');
      await outcome.writeFinished(1);
      await outcome.settle('committed');

      expect(observer.mock.calls).toEqual([[outcomeOf({ status: 'not-committed' })]]);
    });

    it('resolves the call that completes the outcome once the observer has resolved', async () => {
      const observed = deferred();
      const outcome = createOperationOutcome(target, { observer: () => observed.promise });
      await outcome.writeFinished(1);

      let settled = false;
      const settling = outcome.settle('committed').then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      observed.resolve();
      await settling;
      expect(settled).toBe(true);
    });
  });

  describe('an observer that fails', () => {
    it.each([
      [
        'throws',
        () => {
          throw new Error('observer exploded');
        },
      ],
      ['rejects', async () => Promise.reject(new Error('observer exploded'))],
    ])('is logged and ignored when it %s', async (_how, observer) => {
      const outcome = createOperationOutcome(target, { observer });
      await outcome.writeFinished(1);

      await expect(outcome.settle('committed')).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] Error in the audit observer:',
        'observer exploded',
        '(while reporting the complete outcome of update on Post)',
      );
    });

    it('is logged and ignored when it throws a value that cannot be converted to a string', async () => {
      const outcome = createOperationOutcome(target, {
        observer: () => {
          throw Object.create(null);
        },
      });

      await expect(outcome.settle('not-committed')).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] Error in the audit observer:',
        'Thrown value could not be converted to a string',
        '(while reporting the not-committed outcome of update on Post)',
      );
    });
  });

  describe('without an observer', () => {
    it('logs every failure of an incomplete outcome, whose records were lost', async () => {
      const outcome = createOperationOutcome(target, {});
      const writeError = new Error('insert failed');

      outcome.fail(preFetchFailure);
      outcome.fail({ phase: 'log-write', records: [record], error: writeError });
      await outcome.writeFinished(0);
      await outcome.settle('committed');

      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] update on Post committed without some of its audit records; pre-fetch failure:',
        'read failed',
      );
      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] update on Post committed without some of its audit records; log-write failure:',
        'insert failed',
      );
      expect(consoleError).toHaveBeenCalledWith(writeError.stack);
    });

    it.each([
      ['complete', 'committed', []],
      ['not-committed', 'not-committed', [rowIdentificationFailure]],
    ] as const)('logs nothing for a %s outcome', async (_status, fate, failures) => {
      const outcome = createOperationOutcome(target, {});
      for (const failure of failures) {
        outcome.fail(failure);
      }

      await outcome.writeFinished(1);
      await outcome.settle(fate);

      expect(consoleError).not.toHaveBeenCalled();
    });

    it('logs nothing for an unaudited outcome', async () => {
      const outcome = createOperationOutcome({ ...target, unaudited: 'no-context' }, {});

      await outcome.settle('committed');

      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe('droppedRecords', () => {
    it('is undefined when no record was dropped, a pre-fetch failure that only cost a before state included', () => {
      const outcome = createOperationOutcome(target, {});

      outcome.fail(preFetchFailure);

      expect(outcome.droppedRecords()).toBeUndefined();
    });

    it('names the failures that can drop a record and the writes left without one, once a record was dropped', () => {
      const outcome = createOperationOutcome(target, {});

      outcome.fail(preFetchFailure);
      outcome.reportUnrecordedWrite(unrecordedWrite);

      expect(outcome.droppedRecords()).toEqual({ failures: [preFetchFailure], unrecordedWrites: [unrecordedWrite] });
    });

    it('is the failures of a row-identification failure, which drops the record of the row it names', () => {
      const outcome = createOperationOutcome(target, {});

      outcome.fail(rowIdentificationFailure);

      expect(outcome.droppedRecords()).toEqual({ failures: [rowIdentificationFailure], unrecordedWrites: [] });
    });
  });
});

describe('AuditIncompleteError', () => {
  it('names the operation and carries the failures and the writes left without a record, the failures as its cause', () => {
    const failures = [preFetchFailure, rowIdentificationFailure];

    const error = new AuditIncompleteError({
      modelName: 'Post',
      operation: 'updateMany',
      failures,
      unrecordedWrites: [unrecordedWrite],
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuditIncompleteError');
    expect(error.modelName).toBe('Post');
    expect(error.operation).toBe('updateMany');
    expect(error.failures).toEqual(failures);
    expect(error.unrecordedWrites).toEqual([unrecordedWrite]);
    expect(error.cause).toBe(failures);
    expect(error.message).toContain('updateMany on Post');
    expect(error.message).toContain('row-identification: 2 rows not identified');
    expect(error.message).toContain('connectOrCreate of Tag at tags');
  });
});

describe('createTransactionOutcomes', () => {
  const outcomeLog = (events: string[], name: string) => ({
    settle: vi.fn(async (fate: 'committed' | 'not-committed') => {
      events.push(`${name} ${fate}`);
    }),
  });

  it('settles each outcome added while the transaction is open once it settles, as committed only for one that succeeded', async () => {
    const events: string[] = [];
    const outcomes = createTransactionOutcomes();

    await outcomes.add(outcomeLog(events, 'first'), true);
    await outcomes.add(outcomeLog(events, 'second'), false);
    expect(events).toEqual([]);

    await outcomes.settle('committed');
    expect(events).toEqual(['first committed', 'second not-committed']);
  });

  it('settles every outcome as not committed when the transaction rolled back', async () => {
    const events: string[] = [];
    const outcomes = createTransactionOutcomes();

    await outcomes.add(outcomeLog(events, 'first'), true);
    await outcomes.settle('not-committed');

    expect(events).toEqual(['first not-committed']);
  });

  it('settles at once, with the transaction, an outcome added once the transaction has settled', async () => {
    const events: string[] = [];
    const committed = createTransactionOutcomes();
    const rolledBack = createTransactionOutcomes();
    await committed.settle('committed');
    await rolledBack.settle('not-committed');

    await committed.add(outcomeLog(events, 'late success'), true);
    await committed.add(outcomeLog(events, 'late failure'), false);
    await rolledBack.add(outcomeLog(events, 'late on rolled back'), true);

    expect(events).toEqual([
      'late success committed',
      'late failure not-committed',
      'late on rolled back not-committed',
    ]);
  });

  it('settles each outcome once, ignoring a second settlement of the transaction', async () => {
    const events: string[] = [];
    const outcomes = createTransactionOutcomes();
    await outcomes.add(outcomeLog(events, 'first'), true);

    await outcomes.settle('not-committed');
    await outcomes.settle('committed');

    expect(events).toEqual(['first not-committed']);
  });

  it('settles the outcomes of a nested transaction handed to its parent with the parent', async () => {
    const events: string[] = [];
    const parent = createTransactionOutcomes();
    const nested = createTransactionOutcomes();
    await nested.add(outcomeLog(events, 'nested'), true);

    await parent.add(nested, true);
    expect(events).toEqual([]);
    await parent.settle('committed');

    expect(events).toEqual(['nested committed']);
  });
});
