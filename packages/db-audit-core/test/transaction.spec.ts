/**
 * Tests for the audit of a transaction an adapter owns: the outcomes settled with it and the audit
 * failures that keep it from committing, in a transaction of its own or one nested in another.
 */

import { describe, expect, it, vi } from 'vitest';
import { AuditIncompleteError, type OperationOutcome } from '../src/outcome/index.js';
import {
  AuditRollbackError,
  assertRecordsComplete,
  createTransactionAudit,
  settledIn,
} from '../src/transaction/index.js';
import { spiedTransactionAudit } from './support/spied-transaction-audit.js';

const loggedOutcome = (events: string[], name: string): Pick<OperationOutcome, 'settle'> => ({
  settle: vi.fn(async (fate) => {
    events.push(`${name} ${fate}`);
  }),
});

describe('createTransactionAudit', () => {
  describe('assertCommittable', () => {
    it('passes while no audit failure was recorded', () => {
      expect(() => createTransactionAudit().assertCommittable()).not.toThrow();
    });

    it('throws AuditRollbackError, whose cause is the first audit failure recorded, once one was', () => {
      const audit = createTransactionAudit();
      const first = new Error('first');
      audit.poison(first);
      audit.poison(new Error('second'));

      expect(() => audit.assertCommittable()).toThrow(AuditRollbackError);
      expect(() => audit.assertCommittable()).toThrow(expect.objectContaining({ cause: first }));
    });
  });

  it.each([
    { committed: true, fate: 'committed' },
    { committed: false, fate: 'not-committed' },
  ])('end: settles the outcomes as $fate once the transaction committed: $committed', async ({ committed, fate }) => {
    const events: string[] = [];
    const audit = createTransactionAudit();
    await audit.outcomes.add(loggedOutcome(events, 'first'), true);
    await audit.outcomes.add(loggedOutcome(events, 'second'), true);
    expect(events).toEqual([]);

    await audit.end(committed);

    expect(events).toEqual([`first ${fate}`, `second ${fate}`]);
  });

  describe('mergeInto, for a transaction nested in another', () => {
    it('committed: hands its outcomes to the parent, which settles them when it ends', async () => {
      const events: string[] = [];
      const parent = createTransactionAudit();
      const nested = createTransactionAudit();
      await nested.outcomes.add(loggedOutcome(events, 'nested write'), true);

      await nested.mergeInto(parent, true);
      expect(events).toEqual([]);
      await parent.end(true);

      expect(events).toEqual(['nested write committed']);
    });

    it('rolled back: its outcomes settle as not committed with the parent, which it does not poison', async () => {
      const events: string[] = [];
      const parent = createTransactionAudit();
      const nested = createTransactionAudit();
      await nested.outcomes.add(loggedOutcome(events, 'nested write'), true);
      nested.poison(new Error('nested audit failure'));

      await nested.mergeInto(parent, false);
      expect(() => parent.assertCommittable()).not.toThrow();
      await parent.end(true);

      expect(events).toEqual(['nested write not-committed']);
    });
  });
});

describe('assertRecordsComplete', () => {
  const operation = { modelName: 'Post', operation: 'create' };
  const failure = {
    phase: 'row-identification',
    modelName: 'Post',
    operation: 'create',
    unidentified: 1,
    error: new Error('unidentified'),
  } as const;
  const dropped = { failures: [failure], unrecordedWrites: [] };

  it('throws AuditIncompleteError for an atomic operation some of whose records were dropped, recording it on its transaction', () => {
    const { audit, poison } = spiedTransactionAudit();

    expect(() =>
      assertRecordsComplete({ ...operation, mode: 'atomic' }, { droppedRecords: () => dropped }, audit),
    ).toThrow(AuditIncompleteError);
    expect(poison.mock.calls).toEqual([[expect.any(AuditIncompleteError)]]);
  });

  it.each(['awaited', 'deferred'] as const)('passes for a %s operation some of whose records were dropped', (mode) => {
    const { audit, poison } = spiedTransactionAudit();

    assertRecordsComplete({ ...operation, mode }, { droppedRecords: () => dropped }, audit);

    expect(poison).not.toHaveBeenCalled();
  });

  it('passes for an atomic operation none of whose records were dropped', () => {
    const { audit, poison } = spiedTransactionAudit();

    assertRecordsComplete({ ...operation, mode: 'atomic' }, { droppedRecords: () => undefined }, audit);

    expect(poison).not.toHaveBeenCalled();
  });
});

describe('settledIn', () => {
  const outcomeLog = (events: string[]) => ({
    settle: vi.fn(async (fate: 'committed' | 'not-committed') => {
      events.push(fate);
    }),
  });

  describe('outside any transaction', () => {
    it('settles the outcome as committed before returning the result of an operation that succeeded', async () => {
      const events: string[] = [];

      const result = await settledIn(undefined, outcomeLog(events), async () => {
        events.push('ran');
        return 'result';
      });

      expect(result).toBe('result');
      expect(events).toEqual(['ran', 'committed']);
    });

    it('settles the outcome as not committed before rethrowing the error of an operation that failed', async () => {
      const events: string[] = [];
      const operationError = new Error('unique constraint failed');

      await expect(
        settledIn(undefined, outcomeLog(events), async () => {
          throw operationError;
        }),
      ).rejects.toBe(operationError);

      expect(events).toEqual(['not-committed']);
    });
  });

  describe('inside a transaction', () => {
    it.each([
      { succeeded: true, committed: true, fate: 'committed' },
      { succeeded: true, committed: false, fate: 'not-committed' },
      { succeeded: false, committed: true, fate: 'not-committed' },
      { succeeded: false, committed: false, fate: 'not-committed' },
    ])(
      'queues the settlement on the transaction, as $fate once it settles for an operation that succeeded $succeeded in a transaction that committed $committed',
      async ({ succeeded, committed, fate }) => {
        const events: string[] = [];
        const audit = createTransactionAudit();

        await settledIn(audit, outcomeLog(events), async () => {
          if (!succeeded) throw new Error('operation failed');
        }).catch(() => undefined);
        expect(events).toEqual([]);

        await audit.end(committed);
        expect(events).toEqual([fate]);
      },
    );
  });
});
