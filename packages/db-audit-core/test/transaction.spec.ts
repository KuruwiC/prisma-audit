/**
 * Tests for the audit of a transaction an adapter owns: the work queued until it commits, the
 * outcomes settled with it, and the audit failures that keep it from committing, in a
 * transaction of its own or one nested in another.
 */

import { describe, expect, it, vi } from 'vitest';
import { AuditIncompleteError, type OperationOutcome } from '../src/outcome/index.js';
import { AuditRollbackError, assertRecordsComplete, createTransactionAudit } from '../src/transaction/index.js';

const loggedOutcome = (events: string[], name: string): Pick<OperationOutcome, 'settle'> => ({
  settle: vi.fn(async (fate) => {
    events.push(`${name} ${fate}`);
  }),
});

const loggedWork = (events: string[], name: string) => async () => {
  events.push(`${name} ran`);
};

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
      expect(audit.failures).toHaveLength(2);
    });
  });

  it('commit: starts the queued work in order, then settles the outcomes as committed', async () => {
    const events: string[] = [];
    const audit = createTransactionAudit();
    audit.afterCommit(loggedWork(events, 'first'));
    audit.afterCommit(loggedWork(events, 'second'));
    await audit.outcomes.add(loggedOutcome(events, 'write'), true);

    await audit.commit((work) => {
      events.push('start');
      void work();
    });

    expect(events).toEqual(['start', 'first ran', 'start', 'second ran', 'write committed']);
  });

  it('rollBack: settles the outcomes as not committed and starts no queued work', async () => {
    const events: string[] = [];
    const audit = createTransactionAudit();
    audit.afterCommit(loggedWork(events, 'queued'));
    await audit.outcomes.add(loggedOutcome(events, 'write'), true);

    await audit.rollBack();

    expect(events).toEqual(['write not-committed']);
  });

  describe('mergeInto, for a transaction nested in another', () => {
    it('committed: hands its queued work and its outcomes to the parent, which starts and settles them when it commits', async () => {
      const events: string[] = [];
      const parent = createTransactionAudit();
      const nested = createTransactionAudit();
      nested.afterCommit(loggedWork(events, 'nested'));
      await nested.outcomes.add(loggedOutcome(events, 'nested write'), true);

      await nested.mergeInto(parent, true);
      expect(events).toEqual([]);
      await parent.commit((work) => void work());

      expect(events).toEqual(['nested ran', 'nested write committed']);
    });

    it('rolled back: drops its queued work, its outcomes settling as not committed with the parent, which it does not poison', async () => {
      const events: string[] = [];
      const parent = createTransactionAudit();
      const nested = createTransactionAudit();
      nested.afterCommit(loggedWork(events, 'nested'));
      await nested.outcomes.add(loggedOutcome(events, 'nested write'), true);
      nested.poison(new Error('nested audit failure'));

      await nested.mergeInto(parent, false);
      expect(() => parent.assertCommittable()).not.toThrow();
      await parent.commit((work) => void work());

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
    const audit = createTransactionAudit();

    expect(() =>
      assertRecordsComplete({ ...operation, mode: 'atomic' }, { droppedRecords: () => dropped }, audit),
    ).toThrow(AuditIncompleteError);
    expect(audit.failures).toEqual([expect.any(AuditIncompleteError)]);
  });

  it.each(['awaited', 'deferred'] as const)('passes for a %s operation some of whose records were dropped', (mode) => {
    const audit = createTransactionAudit();

    assertRecordsComplete({ ...operation, mode }, { droppedRecords: () => dropped }, audit);

    expect(audit.failures).toEqual([]);
  });

  it('passes for an atomic operation none of whose records were dropped', () => {
    const audit = createTransactionAudit();

    assertRecordsComplete({ ...operation, mode: 'atomic' }, { droppedRecords: () => undefined }, audit);

    expect(audit.failures).toEqual([]);
  });
});
