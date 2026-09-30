/**
 * Tests for the failure sink: the observer hears every failure and never affects the caller;
 * only a failed write consults the write-failure policy, whose 'throw' fails the caller only for
 * a write the caller awaits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../src/domain/branded-types.js';
import type { AuditRecord, MutationEvent, WritePlan } from '../src/domain/mutation-event.js';
import { type AuditErrorContext, createFailureSink } from '../src/failure/index.js';
import type { ResolverFailure } from '../src/resolve/index.js';

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

const planOf = (kind: WritePlan['kind']): WritePlan => ({ kind, records: [record] });

const writeError = new Error('insert failed');

const logWriteContext: AuditErrorContext = {
  phase: 'log-write',
  modelName: 'Post',
  operation: 'write',
  params: [record],
  error: writeError,
};

describe('createFailureSink', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reportWriteFailure', () => {
    it('notifies the observer under log-write with the entity type of the first record and the records as params', async () => {
      const observer = vi.fn();
      const sink = createFailureSink({ observer, writeFailurePolicy: 'ignore' });

      await sink.reportWriteFailure(planOf('immediate'), writeError);

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(logWriteContext);
    });

    it("applies 'log' when no policy is configured: the call resolves and the failure is logged", async () => {
      const sink = createFailureSink({});

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith('[db-audit-core] Error in audit log write:', 'insert failed');
    });

    it("rejects with the original error under 'throw' for an immediate plan", async () => {
      const sink = createFailureSink({ writeFailurePolicy: 'throw' });

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).rejects.toBe(writeError);
    });

    it.each([
      ['after-commit', 'deferred audit log write'],
      ['detached', 'async audit log write'],
    ] as const)("logs instead under 'throw' for an %s plan, whose caller has returned", async (kind, label) => {
      const sink = createFailureSink({ writeFailurePolicy: 'throw' });

      await expect(sink.reportWriteFailure(planOf(kind), writeError)).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(`[db-audit-core] Error in ${label}:`, 'insert failed');
    });

    it("stays silent under 'ignore'", async () => {
      const sink = createFailureSink({ writeFailurePolicy: 'ignore' });

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).resolves.toBeUndefined();

      expect(consoleError).not.toHaveBeenCalled();
    });

    it('passes a policy function the context the observer received and applies what it returns', async () => {
      const observer = vi.fn();
      const writeFailurePolicy = vi.fn(async (_context: AuditErrorContext) => 'throw' as const);
      const sink = createFailureSink({ observer, writeFailurePolicy });

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).rejects.toBe(writeError);

      expect(writeFailurePolicy).toHaveBeenCalledWith(logWriteContext);
      expect(writeFailurePolicy.mock.calls[0]?.[0]).toBe(observer.mock.calls[0]?.[0]);
    });

    it("falls back to 'log' when the policy function throws, so the caller's operation is not failed", async () => {
      const observer = vi.fn(async () => {});
      const sink = createFailureSink({
        observer,
        writeFailurePolicy: async () => {
          throw new Error('policy exploded');
        },
      });

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).resolves.toBeUndefined();

      expect(observer).toHaveBeenCalledWith(logWriteContext);
      expect(consoleError).toHaveBeenCalledWith(
        "[db-audit-core] Error in writeFailurePolicy function; falling back to 'log':",
        'policy exploded',
      );
      expect(consoleError).toHaveBeenCalledWith('[db-audit-core] Error in audit log write:', 'insert failed');
    });
  });

  describe('notify', () => {
    it('notifies the observer without consulting the policy', async () => {
      const observer = vi.fn();
      const writeFailurePolicy = vi.fn(() => 'throw' as const);
      const sink = createFailureSink({ observer, writeFailurePolicy });
      const context = {
        phase: 'pre-fetch',
        modelName: 'Post',
        operation: 'update',
        params: {},
        error: new Error('read failed'),
      } as const;

      await expect(sink.notify(context)).resolves.toBeUndefined();

      expect(observer).toHaveBeenCalledWith(context);
      expect(writeFailurePolicy).not.toHaveBeenCalled();
    });

    it.each([
      [
        'throws',
        () => {
          throw new Error('observer exploded');
        },
      ],
      ['rejects', async () => Promise.reject(new Error('observer exploded'))],
    ])('logs and ignores an observer that %s', async (_how, observer) => {
      const sink = createFailureSink({ observer });

      await expect(
        sink.notify({
          phase: 'diff-generation',
          modelName: 'Post',
          operation: 'create',
          params: {},
          error: writeError,
        }),
      ).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] Error in error-handling observer:',
        'observer exploded',
      );
    });

    it('resolves without an observer', async () => {
      const sink = createFailureSink({});

      await expect(
        sink.notify({ phase: 'pre-fetch', modelName: 'Post', operation: 'update', params: {}, error: writeError }),
      ).resolves.toBeUndefined();
    });
  });

  describe('reportResolverFailures', () => {
    it('notifies one id-resolver-call context per failure with the row identity and the failed resolver', async () => {
      const observer = vi.fn();
      const sink = createFailureSink({ observer });
      const event: MutationEvent = {
        model: 'Post',
        identity: 'p1',
        action: 'create',
        before: { kind: 'none' },
        after: { id: 'p1' },
        origin: { path: 'posts', op: 'create' },
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

      await sink.reportResolverFailures(failures);

      expect(observer.mock.calls).toEqual([
        [
          {
            phase: 'id-resolver-call',
            modelName: 'Post',
            operation: 'create',
            params: { identity: 'p1', resolver: { kind: 'entity' } },
            error: entityError,
          },
        ],
        [
          {
            phase: 'id-resolver-call',
            modelName: 'Post',
            operation: 'create',
            params: {
              identity: 'p1',
              resolver: { kind: 'aggregate', aggregateCategory: 'model', aggregateType: 'User' },
            },
            error: aggregateError,
          },
        ],
      ]);
    });
  });
});
