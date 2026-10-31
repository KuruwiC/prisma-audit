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
      const sink = createFailureSink({ observer });

      await sink.reportWriteFailure(planOf('after-commit'), writeError);

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(logWriteContext);
    });

    it('rejects with the original error for an immediate plan, after notifying the observer, and logs nothing', async () => {
      const order: string[] = [];
      const observer = vi.fn(async () => {
        order.push('observer');
      });
      const sink = createFailureSink({ observer });

      await expect(
        sink.reportWriteFailure(planOf('immediate'), writeError).catch((error: unknown) => {
          order.push('rejected');
          throw error;
        }),
      ).rejects.toBe(writeError);

      expect(observer).toHaveBeenCalledWith(logWriteContext);
      expect(order).toEqual(['observer', 'rejected']);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('rejects with the original error for an immediate plan without an observer, and logs nothing', async () => {
      const sink = createFailureSink({});

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).rejects.toBe(writeError);

      expect(consoleError).not.toHaveBeenCalled();
    });

    it.each([
      ['after-commit', 'deferred audit log write'],
      ['detached', 'async audit log write'],
      ['awaited-after-commit', 'audit log write after commit'],
    ] as const)(
      "resolves for an %s plan, whose operation's write has committed, and logs the failure without an observer",
      async (kind, label) => {
        const sink = createFailureSink({});

        await expect(sink.reportWriteFailure(planOf(kind), writeError)).resolves.toBeUndefined();

        expect(consoleError).toHaveBeenCalledWith(`[db-audit-core] Error in ${label}:`, 'insert failed');
      },
    );

    it.each(['after-commit', 'detached', 'awaited-after-commit'] as const)(
      'resolves for an %s plan and leaves the failure to the observer when one is configured',
      async (kind) => {
        const observer = vi.fn();
        const sink = createFailureSink({ observer });

        await expect(sink.reportWriteFailure(planOf(kind), writeError)).resolves.toBeUndefined();

        expect(observer).toHaveBeenCalledWith(logWriteContext);
        expect(consoleError).not.toHaveBeenCalled();
      },
    );

    it('logs the error of an observer that throws with the message of the write failure, then rejects for an immediate plan', async () => {
      const sink = createFailureSink({
        observer: () => {
          throw new Error('observer exploded');
        },
      });

      await expect(sink.reportWriteFailure(planOf('immediate'), writeError)).rejects.toBe(writeError);

      expect(consoleError.mock.calls).toEqual([
        [
          '[db-audit-core] Error in errorObserver:',
          'observer exploded',
          '(while reporting a log-write failure: insert failed)',
        ],
      ]);
    });

    it('logs the error of an observer that rejects with the message of the write failure, and resolves for a committed write', async () => {
      const sink = createFailureSink({ observer: async () => Promise.reject(new Error('observer exploded')) });

      await expect(sink.reportWriteFailure(planOf('detached'), writeError)).resolves.toBeUndefined();

      expect(consoleError.mock.calls).toEqual([
        [
          '[db-audit-core] Error in errorObserver:',
          'observer exploded',
          '(while reporting a log-write failure: insert failed)',
        ],
      ]);
    });
  });

  describe('reportDroppedBuild', () => {
    const buildError = new Error('read after the write failed');
    const dropped = {
      phase: 'diff-generation',
      modelName: 'Post',
      operation: 'update',
      params: { where: { id: 'p1' } },
      error: buildError,
    } as const;
    const droppedLine = expect.stringMatching(/Post\.update.*dropped/);

    it('notifies the observer with the context it is given, and leaves the failure to it', async () => {
      const observer = vi.fn();
      const sink = createFailureSink({ observer });

      await expect(sink.reportDroppedBuild(dropped)).resolves.toBeUndefined();

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(dropped);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('logs the failure without an observer, naming the model and operation without the params', async () => {
      const sink = createFailureSink({});

      await expect(sink.reportDroppedBuild(dropped)).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(droppedLine, 'read after the write failed');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('"p1"');
    });

    it('resolves when the observer throws, logging its error with the message of the build failure', async () => {
      const sink = createFailureSink({
        observer: () => {
          throw new Error('observer exploded');
        },
      });

      await expect(sink.reportDroppedBuild(dropped)).resolves.toBeUndefined();

      expect(consoleError.mock.calls).toEqual([
        [
          '[db-audit-core] Error in errorObserver:',
          'observer exploded',
          '(while reporting a diff-generation failure: read after the write failed)',
        ],
      ]);
    });
  });

  describe('notify', () => {
    it('notifies the observer', async () => {
      const observer = vi.fn();
      const sink = createFailureSink({ observer });
      const context = {
        phase: 'pre-fetch',
        modelName: 'Post',
        operation: 'update',
        params: {},
        error: new Error('read failed'),
      } as const;

      await expect(sink.notify(context)).resolves.toBeUndefined();

      expect(observer).toHaveBeenCalledWith(context);
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
        '[db-audit-core] Error in errorObserver:',
        'observer exploded',
        '(while reporting a diff-generation failure: insert failed)',
      );
    });

    it('logs and ignores an observer that throws a value that cannot be converted to a string', async () => {
      const sink = createFailureSink({
        observer: () => {
          throw Object.create(null);
        },
      });

      await expect(
        sink.notify({ phase: 'pre-fetch', modelName: 'Post', operation: 'update', params: {}, error: writeError }),
      ).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(
        '[db-audit-core] Error in errorObserver:',
        'Thrown value could not be converted to a string',
        '(while reporting a pre-fetch failure: insert failed)',
      );
    });

    it('resolves without an observer and logs nothing', async () => {
      const sink = createFailureSink({});

      await expect(
        sink.notify({ phase: 'pre-fetch', modelName: 'Post', operation: 'update', params: {}, error: writeError }),
      ).resolves.toBeUndefined();

      expect(consoleError).not.toHaveBeenCalled();
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
