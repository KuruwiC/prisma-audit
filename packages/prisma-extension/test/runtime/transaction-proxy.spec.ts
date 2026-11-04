/**
 * Transaction Proxy Tests
 *
 * The proxy binds every operation to the client it was issued on and runs every interactive
 * transaction through `interactive-transaction.ts`. The specs guard that:
 *
 * - the client an interactive `$transaction` callback receives is bound to that transaction, and
 *   an operation issued on it stays bound when the actor is re-attributed inside the callback
 *   (via full `runAsync` replacement or `withActor`), because the binding lives on a separate,
 *   library-owned runtime store;
 * - an operation issued on the outer client, inside a callback or not, is bound to no transaction;
 * - a batch `$transaction([...])` holding a write runs as one interactive transaction, its
 *   operations in order; a batch of reads and raw queries only is Prisma's own batch, whose
 *   operations start without a binding;
 * - the queued audit writes start strictly AFTER commit, so an audit log never persists for a
 *   transaction whose commit subsequently fails, and are discarded unrun otherwise;
 * - a callback that resolves after an audit failure failed one of its operations is rolled back.
 *
 * The specs observe the runtime as an audited operation does: an operation run through the
 * audited pipeline takes its transaction from the binding it starts with and writes its audit
 * through a fake writer.
 */

import {
  type AuditActor,
  type AuditContext,
  type AuditRecord,
  createActorId,
  createAggregateId,
  createAsyncLocalStorageProvider,
  createEntityId,
  createFailureSink,
  type FailureSink,
  planFor,
  type WriteMode,
} from '@kuruwic/db-audit-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditRollbackError } from '../../src/errors.js';
import type { PrismaBaseClient, PrismaHandle } from '../../src/internal-types.js';
import type { OperationExecutor } from '../../src/pipeline/executor.js';
import { type AuditPipelineDependencies, runAuditedOperation } from '../../src/pipeline/run-audited-operation.js';
import type { RecipeConfig } from '../../src/runtime/operation-recipe.js';
import { flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
import { currentScope, operationBinding, type RuntimeScope } from '../../src/runtime/scope.js';
import { createTransactionProxy } from '../../src/runtime/transaction-proxy.js';
import type { AuditLogData } from '../../src/types.js';
import { stubFailureSink } from '../support/failure-sink.js';
import { lazyOperation } from '../support/lazy-operation.js';

const actor1: AuditActor = { category: 'model', type: 'User', id: 'user-1' };
const actor2: AuditActor = { category: 'model', type: 'User', id: 'user-2' };

const baseContext: AuditContext = { actor: actor1, request: { ipAddress: '10.0.0.1' } };

/** The client the audited pipeline writes on outside any transaction; an audit that opens a transaction fails */
const baseClient: PrismaBaseClient = {
  $transaction: async () => {
    throw new Error('the audit of these operations opens no transaction');
  },
  $extends: () => {
    throw new Error('not used');
  },
};

const recordOf = (id: string): AuditLogData => ({
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'User',
  entityId: createEntityId(id),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'User',
  aggregateId: createAggregateId(id),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id },
  changes: null,
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
});

const creatingExecutor: OperationExecutor = {
  run: async (operation) => {
    const result = await operation.execute(operation.args);
    return { result, buildRecords: async () => [recordOf(String(operation.args.id))] };
  },
};

type AuditWrite = (handle: PrismaHandle, records: AuditRecord[]) => Promise<void>;

const createDeps = (write: AuditWrite, failureSink: FailureSink = stubFailureSink()): AuditPipelineDependencies => ({
  singleExecutor: creatingExecutor,
  batchExecutor: creatingExecutor,
  produceRecords: vi.fn(async () => []),
  dispatchConfig: { writeExecutor: { write: vi.fn(write) }, failureSink },
  failureSinkConfig: {},
});

const auditWriteOf = (deps: AuditPipelineDependencies) => vi.mocked(deps.dispatchConfig.writeExecutor.write);

const writtenIds = (deps: AuditPipelineDependencies): string[] =>
  auditWriteOf(deps).mock.calls.flatMap(([, records]) => records.map((written) => String(written.entityId)));

/**
 * The arguments of a create of the row `id` on the audited client: its write mode is atomic when
 * `atomic` and deferred otherwise, and its own write fails when `fails`
 */
interface CreateArgs {
  readonly id: string;
  readonly atomic: boolean;
  readonly fails?: boolean;
}

/**
 * A client whose `user.create` runs the audited pipeline as the audit extension's hook does: the
 * transaction the operation runs in is the one its binding names, and `query` continues the
 * operation
 */
const auditedClientOf = (deps: AuditPipelineDependencies) => ({
  user: {
    create: (args: CreateArgs) =>
      lazyOperation(() => {
        const mode: WriteMode = args.atomic ? 'atomic' : 'deferred';
        const transaction = operationBinding()?.transaction;
        const plan = planFor(mode, transaction !== undefined);
        if (plan === 'reject') {
          throw new Error('an atomic create reached the audit outside any transaction');
        }
        return runAuditedOperation(
          {
            operation: {
              model: 'User',
              action: 'create',
              args: { id: args.id },
              query: async () => {
                if (args.fails) throw new Error(`Unique constraint failed: ${args.id}`);
                return args;
              },
              widened: new Map(),
            },
            auditContext: baseContext,
            baseClient,
            mode,
            plan,
            transaction,
          },
          deps,
        );
      }),
  },
});

/** What an operation of a probe client saw when Prisma started it */
interface Probed {
  readonly action: string;
  readonly client: string;
  readonly scope: RuntimeScope | undefined;
}

/** A client whose operations are lazy and record the client they ran on and the scope they started in */
const probeClientNamed = (name: string, ran: Probed[]) => {
  const probing = (action: string, result: unknown) =>
    lazyOperation(async () => {
      ran.push({ action, client: name, scope: currentScope() });
      return result;
    });
  return {
    marker: `the ${name} client`,
    user: {
      create: (args: unknown) => probing('create', { created: args }),
      findMany: () => probing('findMany', []),
    },
    $queryRaw: () => probing('$queryRaw', 'raw'),
  };
};

type ProbeClient = ReturnType<typeof probeClientNamed>;

const bindingOf = (probed: Probed | undefined) => probed?.scope?.binding;

const transactionClientOf = (probed: Probed | undefined): unknown => bindingOf(probed)?.transaction?.client;

/**
 * The `$transaction` of a client: a batch is Prisma's own, which runs its operations as they are,
 * and an interactive callback is run with `txClient` by `settle`, which also settles the commit
 */
const transactionOf = <TTx extends object>(
  txClient: TTx,
  settle: (runCallback: () => Promise<unknown>) => Promise<unknown> = (runCallback) => runCallback(),
) =>
  vi.fn(
    async (
      first: ((tx: TTx) => PromiseLike<unknown>) | readonly PromiseLike<unknown>[],
      ..._options: unknown[]
    ): Promise<unknown> => (typeof first === 'function' ? settle(async () => first(txClient)) : Promise.all(first)),
  );

/** A recipe config by which every call is an atomic write when `atomic`, and none otherwise */
const recipeConfigAtomic = (atomic: boolean): RecipeConfig => ({
  modelOfAccessor: new Map([['user', 'User']]),
  relatedModel: () => undefined,
  isAtomicWrite: () => atomic,
});

const recipeConfig = recipeConfigAtomic(false);

describe('createTransactionProxy (property access)', () => {
  /** A client with methods on its prototype, as a Prisma client has */
  class FakeClient {
    readonly user = { findMany: async (): Promise<unknown[]> => [] };
    readonly extensions: unknown[] = [];
    async $connect(): Promise<void> {}
    async $transaction(...args: unknown[]): Promise<unknown> {
      return args;
    }
    $extends(extension: unknown): FakeClient {
      const derived = new FakeClient();
      derived.extensions.push(...this.extensions, extension);
      return derived;
    }
  }

  const noModels: RecipeConfig = {
    modelOfAccessor: new Map(),
    relatedModel: () => undefined,
    isAtomicWrite: () => false,
  };

  it('returns every property other than $transaction, $extends and the wrapped operations as the client holds it', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, {
      provider: createAsyncLocalStorageProvider(),
      recipeConfig: noModels,
    });

    expect(proxy.user).toBe(target.user);
    expect(proxy.user.findMany).toBe(proxy.user.findMany);
    expect(proxy.$connect).toBe(target.$connect);
  });

  it('answers `in` and the prototype chain from the client itself', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, {
      provider: createAsyncLocalStorageProvider(),
      recipeConfig: noModels,
    });

    expect('user' in proxy).toBe(true);
    expect('$transaction' in proxy).toBe(true);
    expect('missing' in proxy).toBe(false);
    expect(Object.getPrototypeOf(proxy)).toBe(FakeClient.prototype);
    expect(proxy).toBeInstanceOf(FakeClient);
  });

  it.each([
    ['a string', 'SELECT 1'],
    ['an object', { sql: 'SELECT 1' }],
  ])('passes a first argument of $transaction that is %s to Prisma untouched', async (_kind, first) => {
    const target = new FakeClient();
    const original = vi.spyOn(target, '$transaction');
    const proxy = createTransactionProxy(target, {
      provider: createAsyncLocalStorageProvider(),
      recipeConfig,
    });
    const options = { isolationLevel: 'Serializable' };

    await proxy.$transaction(first, options);

    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]).toHaveLength(2);
    expect(original.mock.calls[0]?.[0]).toBe(first);
    expect(original.mock.calls[0]?.[1]).toBe(options);
    expect(original.mock.instances[0]).toBe(target);
  });
});

describe('createTransactionProxy (interactive $transaction)', () => {
  /** A proxy over a probe client whose interactive transactions hand callbacks a probe transaction client */
  const probeProxy = (settle?: Parameters<typeof transactionOf>[1]) => {
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const tx = probeClientNamed('transaction', ran);
    const $transaction = transactionOf<ProbeClient>(tx, settle);
    const target = { ...probeClientNamed('client', ran), $transaction };
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig }), tx, ran, $transaction };
  };

  describe('the client the callback receives', () => {
    it('is not the transaction client, and returns every property but the wrapped operations as the transaction client holds it', async () => {
      const { provider, proxy, tx } = probeProxy();
      let received: ProbeClient | undefined;

      await provider.runAsync(baseContext, () =>
        proxy.$transaction(async (bound) => {
          received = bound;
          return undefined;
        }),
      );

      expect(received).not.toBe(tx);
      expect(received?.marker).toBe(tx.marker);
      expect(received && 'marker' in received).toBe(true);
    });

    it('binds the operations issued on it to the transaction, model operations and raw queries alike', async () => {
      const { provider, proxy, tx, ran } = probeProxy();

      await provider.runAsync(baseContext, () =>
        proxy.$transaction(async (bound) => {
          await bound.user.create({ email: 'a' });
          await bound.user.findMany();
          await bound.$queryRaw();
        }),
      );

      expect(ran.map(({ action, client }) => ({ action, client }))).toEqual([
        { action: 'create', client: 'transaction' },
        { action: 'findMany', client: 'transaction' },
        { action: '$queryRaw', client: 'transaction' },
      ]);
      expect(ran.map(transactionClientOf)).toEqual([tx, tx, tx]);
      expect(new Set(ran.map((probed) => bindingOf(probed)?.transaction)).size).toBe(1);
    });

    it('runs the lazy operation the callback returns without awaiting it, bound to the transaction', async () => {
      const { provider, proxy, tx, ran } = probeProxy();

      const result = await provider.runAsync(baseContext, () => proxy.$transaction((bound) => bound.user.create({})));

      expect(result).toEqual({ created: {} });
      expect(ran.map(transactionClientOf)).toEqual([tx]);
    });

    it('keeps an operation issued on it bound to the transaction after a full runAsync actor replacement', async () => {
      const { provider, proxy, tx, ran } = probeProxy();

      const result = await provider.runAsync(baseContext, () =>
        proxy.$transaction(async (bound) =>
          // Full context replacement: the actor (and request) are swapped on the app store.
          provider.runAsync({ actor: actor2 }, async () => {
            await bound.user.create({});
            return 'ok';
          }),
        ),
      );

      expect(result).toBe('ok');
      expect(ran.map(transactionClientOf)).toEqual([tx]);
    });

    it('keeps an operation issued on it bound to the transaction and preserves request metadata under withActor', async () => {
      const { provider, proxy, tx, ran } = probeProxy();
      let contextInsideOverride: AuditContext | undefined;

      const result = await provider.runAsync(baseContext, () =>
        proxy.$transaction(async (bound) =>
          provider.withActor(actor2, async () => {
            contextInsideOverride = provider.getContext();
            await bound.user.create({});
            return 'ok';
          }),
        ),
      );

      expect(result).toBe('ok');
      expect(ran.map(transactionClientOf)).toEqual([tx]);
      expect(contextInsideOverride?.actor).toEqual(actor2);
      // withActor preserves the rest of the app context (request metadata)
      expect(contextInsideOverride?.request).toEqual(baseContext.request);
    });

    it('runs a plain arrow returning a lazy operation under the overridden actor, bound to the transaction', async () => {
      // The operation starts as `.then` is called: the async wrapper in withActor makes that happen
      // INSIDE the overridden scope, while its storage.run scope is still active.
      const { provider, proxy, tx, ran } = probeProxy();
      const actorsSeen: Array<string | undefined> = [];
      const bound = (client: ProbeClient) =>
        lazyOperation(async () => {
          actorsSeen.push(provider.getContext()?.actor.id);
          return client.user.create({});
        });

      await provider.runAsync(baseContext, () =>
        proxy.$transaction(async (client) => {
          await provider.withActor(actor2, () => bound(client));
        }),
      );

      expect(actorsSeen).toEqual(['user-2']);
      expect(ran.map(transactionClientOf)).toEqual([tx]);
    });

    it('is usable without an audit context, binding the operations issued on it to the transaction', async () => {
      const { provider, proxy, tx, ran } = probeProxy();
      let contextInsideCallback: AuditContext | undefined;

      await proxy.$transaction(async (bound) =>
        provider.runAsync(baseContext, async () => {
          await bound.user.create({});
          contextInsideCallback = provider.getContext();
        }),
      );

      expect(ran.map(transactionClientOf)).toEqual([tx]);
      expect(contextInsideCallback).toBe(baseContext);
    });
  });

  it('binds a write on the outer client inside the callback to no transaction', async () => {
    const { provider, proxy, tx, ran } = probeProxy();

    await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await proxy.user.create({ email: 'outer' });
        await bound.user.create({ email: 'bound' });
      }),
    );

    expect(ran.map(({ client }) => client)).toEqual(['client', 'transaction']);
    expect(bindingOf(ran[0])).toEqual({ transaction: undefined });
    expect(transactionClientOf(ran[1])).toBe(tx);
  });

  it('forwards the options of an interactive $transaction to Prisma, and passes none when it got none', async () => {
    const { provider, proxy, $transaction } = probeProxy();
    const options = { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 };

    await provider.runAsync(baseContext, () => proxy.$transaction(async () => 'with options', options));
    await provider.runAsync(baseContext, () => proxy.$transaction(async () => 'without options'));

    expect($transaction.mock.calls[0]).toHaveLength(2);
    expect($transaction.mock.calls[0]?.[1]).toBe(options);
    expect($transaction.mock.calls[1]).toHaveLength(1);
  });

  it('resolves with the result of the callback', async () => {
    const { provider, proxy } = probeProxy();

    await expect(provider.runAsync(baseContext, () => proxy.$transaction(async () => 'committed'))).resolves.toBe(
      'committed',
    );
  });

  it('proxies a client derived by $extends, so that its interactive $transaction hands the callback a bound client', async () => {
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const derivedTx = probeClientNamed('derived transaction', ran);
    const derivedTarget = {
      ...probeClientNamed('derived', ran),
      $transaction: transactionOf<ProbeClient>(derivedTx),
    };
    const extensions: unknown[] = [];
    const target = {
      ...probeClientNamed('client', ran),
      $transaction: transactionOf<ProbeClient>(probeClientNamed('transaction', ran)),
      $extends: (extension: unknown) => {
        extensions.push(extension);
        return derivedTarget;
      },
    };
    const extension = { name: 'derived' };
    const proxy = createTransactionProxy(target, { provider, recipeConfig });

    const derived = proxy.$extends(extension);
    await provider.runAsync(baseContext, async () => {
      await derived.$transaction(async (bound) => {
        await bound.user.create({});
      });
      await derived.user.create({});
    });

    expect(extensions).toEqual([extension]);
    expect(ran.map(({ client }) => client)).toEqual(['derived transaction', 'derived']);
    expect(transactionClientOf(ran[0])).toBe(derivedTx);
    expect(bindingOf(ran[1])).toEqual({ transaction: undefined });
  });
});

describe('createTransactionProxy (operation recipes)', () => {
  /** A client whose `user` operations record the client they ran on and whether Prisma's own batch ran them */
  const createRecipeProxy = (recipe: RecipeConfig) => {
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const tx = probeClientNamed('transaction', ran);
    const $transaction = transactionOf<ProbeClient>(tx);
    const target = { ...probeClientNamed('client', ran), $transaction };
    return {
      provider,
      proxy: createTransactionProxy(target, { provider, recipeConfig: recipe }),
      tx,
      ran,
      $transaction,
    };
  };

  it('returns the same delegate and the same action for a property read twice', () => {
    const { proxy } = createRecipeProxy(recipeConfigAtomic(true));

    expect(proxy.user).toBe(proxy.user);
    expect(proxy.user.create).toBe(proxy.user.create);
  });

  it('runs nothing until a call is awaited, then runs an atomic write in an interactive transaction of the client', async () => {
    const { provider, proxy, tx, ran, $transaction } = createRecipeProxy(recipeConfigAtomic(true));

    const created = proxy.user.create({ email: 'a' });
    expect(ran).toEqual([]);

    await expect(provider.runAsync(baseContext, async () => await created)).resolves.toEqual({
      created: { email: 'a' },
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(ran.map(({ client }) => client)).toEqual(['transaction']);
    expect(ran.map(transactionClientOf)).toEqual([tx]);
  });

  it('runs a call that is not an atomic write on the client itself, bound to no transaction', async () => {
    const { provider, proxy, ran, $transaction } = createRecipeProxy(recipeConfigAtomic(false));

    await provider.runAsync(baseContext, async () => await proxy.user.create({ email: 'a' }));

    expect($transaction).not.toHaveBeenCalled();
    expect(ran.map(({ client }) => client)).toEqual(['client']);
    expect(ran.map(bindingOf)).toEqual([{ transaction: undefined }]);
  });

  describe('a batch $transaction holding a write', () => {
    it.each([
      { write: 'an atomic write', config: recipeConfigAtomic(true) },
      { write: 'not an atomic write', config: recipeConfigAtomic(false) },
    ])(
      'runs as one interactive transaction of the client, its operations in order and bound to it, when its write is $write, at the isolation level of the caller',
      async ({ config }) => {
        const { provider, proxy, tx, ran, $transaction } = createRecipeProxy(config);

        const results = await provider.runAsync(baseContext, () =>
          proxy.$transaction([proxy.user.create({ email: 'a' }), proxy.user.findMany(), proxy.$queryRaw()], {
            isolationLevel: 'Serializable',
          }),
        );

        expect(results).toEqual([{ created: { email: 'a' } }, [], 'raw']);
        expect(ran.map(({ action, client }) => ({ action, client }))).toEqual([
          { action: 'create', client: 'transaction' },
          { action: 'findMany', client: 'transaction' },
          { action: '$queryRaw', client: 'transaction' },
        ]);
        expect(ran.map(transactionClientOf)).toEqual([tx, tx, tx]);
        expect($transaction).toHaveBeenCalledTimes(1);
        expect(typeof $transaction.mock.calls[0]?.[0]).toBe('function');
        expect($transaction.mock.calls[0]?.slice(1)).toEqual([{ isolationLevel: 'Serializable' }]);
      },
    );

    it('is given only the isolation level of the options of the batch, and none when there is none', async () => {
      const { provider, proxy, $transaction } = createRecipeProxy(recipeConfigAtomic(true));

      await provider.runAsync(baseContext, async () => {
        await proxy.$transaction([proxy.user.create({ email: 'a' })], { isolationLevel: 'Serializable', maxWait: 1 });
        await proxy.$transaction([proxy.user.create({ email: 'b' })], { maxWait: 1 });
        await proxy.$transaction([proxy.user.create({ email: 'c' })]);
      });

      expect($transaction.mock.calls.map((call) => call.slice(1))).toEqual([
        [{ isolationLevel: 'Serializable' }],
        [],
        [],
      ]);
    });

    it('rejects a batch holding an operation that is not a call of the client before running anything', async () => {
      const { provider, proxy, ran, $transaction } = createRecipeProxy(recipeConfigAtomic(true));
      const foreign = vi.fn(() => 'foreign');

      await expect(
        provider.runAsync(baseContext, () =>
          proxy.$transaction([proxy.user.create({ email: 'a' }), lazyOperation(foreign)]),
        ),
      ).rejects.toThrow('The operation at index 1 of the batch $transaction was not created by an audited client');

      expect($transaction).not.toHaveBeenCalled();
      expect(foreign).not.toHaveBeenCalled();
      expect(ran).toEqual([]);
    });
  });

  describe("a batch $transaction of reads and raw queries only, which is Prisma's own batch", () => {
    it.each([
      { write: 'an atomic write', config: recipeConfigAtomic(true) },
      { write: 'not an atomic write', config: recipeConfigAtomic(false) },
    ])('passes its operations and its options to Prisma, when a write is $write', async ({ config }) => {
      const { provider, proxy, ran, $transaction } = createRecipeProxy(config);
      const options = { isolationLevel: 'Serializable', maxWait: 1 };

      const results = await provider.runAsync(baseContext, () =>
        proxy.$transaction([proxy.user.findMany(), proxy.$queryRaw()], options),
      );

      expect(results).toEqual([[], 'raw']);
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(Array.isArray($transaction.mock.calls[0]?.[0])).toBe(true);
      expect($transaction.mock.calls[0]).toHaveLength(2);
      expect($transaction.mock.calls[0]?.[1]).toBe(options);
      expect(ran.map(({ client }) => client)).toEqual(['client', 'client']);
    });

    it('starts its operations without a binding, so that a write reaching the audit from one is unbound', async () => {
      const { provider, proxy, ran } = createRecipeProxy(recipeConfigAtomic(true));

      await provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.findMany(), proxy.$queryRaw()]));

      expect(ran).toHaveLength(2);
      expect(ran.map(bindingOf)).toEqual([undefined, undefined]);
    });

    it('passes the options to Prisma only when it got some', async () => {
      const { provider, proxy, $transaction } = createRecipeProxy(recipeConfig);

      await provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.findMany()]));

      expect($transaction.mock.calls[0]).toHaveLength(1);
    });
  });

  it("passes an empty batch to Prisma's own batch, which has nothing to run", async () => {
    const { provider, proxy, ran, $transaction } = createRecipeProxy(recipeConfigAtomic(true));

    await expect(provider.runAsync(baseContext, () => proxy.$transaction([]))).resolves.toEqual([]);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]).toEqual([[]]);
    expect(ran).toEqual([]);
  });

  describe('the next operation of the client', () => {
    it.each<[string, (proxy: ReturnType<typeof createRecipeProxy>['proxy']) => Promise<unknown>]>([
      ['a batch holding a write', (proxy) => proxy.$transaction([proxy.user.create({ email: 'a' })])],
      ['a batch of reads only', (proxy) => proxy.$transaction([proxy.user.findMany()])],
      ['an interactive transaction', (proxy) => proxy.$transaction(async () => 'interactive')],
    ])(
      'is bound to no transaction, and starts in no scope that remains from the $transaction, once %s has settled',
      async (_kind, transaction) => {
        const { provider, proxy, ran } = createRecipeProxy(recipeConfig);

        await provider.runAsync(baseContext, async () => {
          await transaction(proxy);
          ran.length = 0;
          await proxy.user.create({ email: 'next' });
        });

        expect(ran.map(({ client }) => client)).toEqual(['client']);
        expect(ran[0]?.scope).toEqual({ binding: { transaction: undefined } });
      },
    );
  });
});

describe('createTransactionProxy (audit writes queued until the commit)', () => {
  /** A proxy over a client whose operations run the audited pipeline, and whose interactive transactions are settled by `settle` */
  const auditedProxy = (deps: AuditPipelineDependencies, settle?: Parameters<typeof transactionOf>[1]) => {
    const tx = auditedClientOf(deps);
    const provider = createAsyncLocalStorageProvider();
    const target = { ...auditedClientOf(deps), $transaction: transactionOf(tx, settle) };
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig }), tx };
  };

  it('starts the audit write of an operation run under an actor override once the transaction has committed, as a pending write', async () => {
    let finishWrite: () => void = () => {};
    const deps = createDeps(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { provider, proxy } = auditedProxy(deps);
    let writesInsideTransaction = -1;

    // An audit whose write is not awaited, run under an actor override, queues its write until the commit
    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (tx) => {
        await provider.withActor(actor2, () => tx.user.create({ id: 'u1', atomic: false }));
        writesInsideTransaction = auditWriteOf(deps).mock.calls.length;
        return 'committed';
      }),
    );
    const writesAfterCommit = auditWriteOf(deps).mock.calls.length;
    const pendingAfterCommit = getPendingWriteCount();
    finishWrite();
    await flushAllPendingWrites();

    expect(result).toBe('committed');
    expect(writesInsideTransaction).toBe(0);
    expect(writesAfterCommit).toBe(1);
    expect(pendingAfterCommit).toBe(1);
    expect(getPendingWriteCount()).toBe(0);
    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(baseClient, [recordOf('u1')]);
  });

  it("does not start the queued audit writes until the client's $transaction resolves", async () => {
    // Proves the writes start strictly AFTER commit, not inside the user callback.
    const deps = createDeps(async () => {});
    let writesAtCommitTime = -1;
    const { provider, proxy } = auditedProxy(deps, async (runCallback) => {
      const result = await runCallback();
      // Observe at "commit time": the callback has resolved but the writes have not been started yet.
      writesAtCommitTime = auditWriteOf(deps).mock.calls.length;
      return result;
    });

    await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (tx) => {
        await tx.user.create({ id: 'u1', atomic: false });
      }),
    );
    await flushAllPendingWrites();

    // The audit write had NOT started while the transaction was still settling the commit.
    expect(writesAtCommitTime).toBe(0);
    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(baseClient, [recordOf('u1')]);
  });

  it('discards the queued audit writes when the transaction callback throws (rollback)', async () => {
    const deps = createDeps(async () => {});
    const { provider, proxy } = auditedProxy(deps);

    await expect(
      provider.runAsync(baseContext, () =>
        proxy.$transaction(async (tx) => {
          await provider.runAsync({ actor: actor2 }, async () => await tx.user.create({ id: 'u1', atomic: false }));
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');
    await flushAllPendingWrites();

    expect(auditWriteOf(deps)).not.toHaveBeenCalled();
  });

  it('discards the queued audit writes when the transaction rejects after the callback succeeded (commit failure)', async () => {
    // The user callback runs to completion and queues an audit write, but the commit itself
    // fails. The proxy must NOT start it: no audit log for a rolled-back transaction.
    const deps = createDeps(async () => {});
    const { provider, proxy } = auditedProxy(deps, async (runCallback) => {
      await runCallback();
      throw new Error('commit failed');
    });

    await expect(
      provider.runAsync(baseContext, () =>
        proxy.$transaction(async (tx) => {
          await tx.user.create({ id: 'u1', atomic: false });
          return 'callback-ok';
        }),
      ),
    ).rejects.toThrow('commit failed');
    await flushAllPendingWrites();

    expect(auditWriteOf(deps)).not.toHaveBeenCalled();
  });
});

describe('createTransactionProxy (audit failures recorded on the transaction)', () => {
  const writeError = new Error('audit table unavailable');

  /** An audit write that fails for the row `bad`, reported by a failure sink that fails the caller of an immediate write */
  const depsFailingFor = (bad: string) =>
    createDeps(async (_handle, records) => {
      if (records.some((written) => written.entityId === bad)) throw writeError;
    }, createFailureSink({}));

  const auditedProxy = (deps: AuditPipelineDependencies) => {
    const tx = auditedClientOf(deps);
    const provider = createAsyncLocalStorageProvider();
    const target = { ...auditedClientOf(deps), $transaction: transactionOf(tx) };
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig }), tx };
  };

  it('rejects $transaction with an AuditRollbackError, discarding the queued writes, when the callback resolves after an operation failed on its audit', async () => {
    const deps = depsFailingFor('bad');
    const { provider, proxy, tx } = auditedProxy(deps);

    const running = provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await bound.user.create({ id: 'u1', atomic: false });
        // The callback catches the failure of the operation, and resolves all the same
        await bound.user.create({ id: 'bad', atomic: true }).then(undefined, () => undefined);
        return 'resolved all the same';
      }),
    );

    await expect(running).rejects.toBeInstanceOf(AuditRollbackError);
    await expect(running).rejects.toHaveProperty('cause', writeError);
    await flushAllPendingWrites();
    expect(writtenIds(deps)).toEqual(['bad']);
    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(tx, [recordOf('bad')]);
  });

  it('resolves normally, and starts the queued writes, when no audit failure was recorded on the transaction', async () => {
    const deps = depsFailingFor('bad');
    const { provider, proxy } = auditedProxy(deps);

    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await bound.user.create({ id: 'u1', atomic: false });
        await bound.user.create({ id: 'u2', atomic: true });
        return 'committed';
      }),
    );
    await flushAllPendingWrites();

    expect(result).toBe('committed');
    expect(writtenIds(deps)).toEqual(['u2', 'u1']);
  });

  it("does not record the caller's own mutation failure, which the callback may catch", async () => {
    const deps = depsFailingFor('bad');
    const { provider, proxy } = auditedProxy(deps);

    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await bound.user.create({ id: 'u1', atomic: true, fails: true }).then(undefined, () => undefined);
        return 'caught';
      }),
    );

    expect(result).toBe('caught');
    expect(auditWriteOf(deps)).not.toHaveBeenCalled();
  });

  it('records the failure on the transaction the failed operation was issued on, not on one around it', async () => {
    const deps = depsFailingFor('bad');
    const { provider, proxy } = auditedProxy(deps);

    // The inner transaction rolls back for the audit failure; the outer callback catches that
    // rejection, and its own transaction commits.
    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async () => {
        await proxy
          .$transaction(async (inner) => {
            await inner.user.create({ id: 'bad', atomic: true }).then(undefined, () => undefined);
          })
          .then(undefined, () => undefined);
        return 'outer committed';
      }),
    );

    expect(result).toBe('outer committed');
  });
});

describe('createTransactionProxy (audit of a batch holding a write)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An audit write that logs `started <id>`, takes a while on the fake clock, then logs
   * `written <id>` or fails with `writeError`. The clock moves only once every pending microtask
   * has run, so whatever does not wait for the write runs before it finishes.
   */
  const loggingWrite =
    (events: string[], writeError?: Error): AuditWrite =>
    async (_handle, records) => {
      events.push(...records.map((started) => `started ${started.entityId}`));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (writeError) throw writeError;
      events.push(...records.map((written) => `written ${written.entityId}`));
    };

  /** A proxy over a client whose batches run as the interactive transaction of `tx`, logging `committed` once the callback has resolved */
  const batchProxy = (events: string[], deps: AuditPipelineDependencies) => {
    const tx = auditedClientOf(deps);
    const provider = createAsyncLocalStorageProvider();
    const target = {
      ...auditedClientOf(deps),
      $transaction: transactionOf(tx, async (runCallback) => {
        const result = await runCallback();
        events.push('committed');
        return result;
      }),
    };
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig }), tx };
  };

  const create = (id: string, atomic: boolean): CreateArgs => ({ id, atomic });

  /** Runs `batch` to its end on the fake clock, then lets the pending writes finish */
  const settled = async (batch: Promise<unknown>) => {
    const outcome = batch.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    await vi.runAllTimersAsync();
    const result = await outcome;
    await flushAllPendingWrites();
    return result;
  };

  it('writes the audit of an awaited operation by the transaction, one operation after another, and resolves the batch once they have finished', async () => {
    const events: string[] = [];
    const deps = createDeps(loggingWrite(events));
    const { provider, proxy, tx } = batchProxy(events, deps);

    const outcome = await settled(
      provider
        .runAsync(baseContext, () =>
          proxy.$transaction([proxy.user.create(create('u1', true)), proxy.user.create(create('u2', true))]),
        )
        .then((result) => {
          events.push('resolved');
          return result;
        }),
    );

    expect(outcome).toBe('resolved');
    expect(events).toEqual(['started u1', 'written u1', 'started u2', 'written u2', 'committed', 'resolved']);
    expect(auditWriteOf(deps).mock.calls.map(([handle]) => handle)).toEqual([tx, tx]);
  });

  it("starts the audit writes of operations it does not await only once the batch has committed, and resolves the caller's batch without waiting for them", async () => {
    const events: string[] = [];
    const deps = createDeps(loggingWrite(events));
    const { provider, proxy } = batchProxy(events, deps);

    const outcome = await settled(
      provider
        .runAsync(baseContext, () =>
          proxy.$transaction([proxy.user.create(create('u1', false)), proxy.user.create(create('u2', false))]),
        )
        .then((result) => {
          events.push('resolved');
          return result;
        }),
    );

    expect(outcome).toBe('resolved');
    expect(events).toEqual(['committed', 'started u1', 'started u2', 'resolved', 'written u1', 'written u2']);
    expect(auditWriteOf(deps).mock.calls.map(([handle]) => handle)).toEqual([baseClient, baseClient]);
  });

  it.each([
    { awaited: 'awaited', atomic: true, written: ['u1'], handle: 'the transaction client' },
    { awaited: 'not awaited', atomic: false, written: [], handle: 'nothing' },
  ])(
    'leaves the audit of an operation whose audit is $awaited to the transaction when a later operation of the batch fails and the batch rolls back: it writes $handle',
    async ({ atomic, written }) => {
      const events: string[] = [];
      const deps = createDeps(loggingWrite(events));
      const { provider, proxy, tx } = batchProxy(events, deps);

      const outcome = await settled(
        provider.runAsync(baseContext, () =>
          proxy.$transaction([
            proxy.user.create(create('u1', atomic)),
            proxy.user.create({ ...create('u2', atomic), fails: true }),
          ]),
        ),
      );

      expect(outcome).toBe('rejected');
      expect(events).not.toContain('committed');
      expect(writtenIds(deps)).toEqual(written);
      for (const [handle] of auditWriteOf(deps).mock.calls) {
        expect(handle).toBe(tx);
      }
    },
  );

  it('keeps the audit writes of two batches running at once apart', async () => {
    const events: string[] = [];
    const deps = createDeps(loggingWrite(events));
    const { provider, proxy } = batchProxy(events, deps);

    const batches = provider.runAsync(baseContext, () =>
      Promise.allSettled([
        proxy.$transaction([
          proxy.user.create(create('u1', false)),
          proxy.user.create({ ...create('u2', false), fails: true }),
        ]),
        proxy.$transaction([proxy.user.create(create('u3', false)), proxy.user.create(create('u4', false))]),
      ]),
    );
    await vi.runAllTimersAsync();
    const [rolledBack, committed] = await batches;
    await flushAllPendingWrites();

    expect(rolledBack?.status).toBe('rejected');
    expect(committed?.status).toBe('fulfilled');
    expect(writtenIds(deps)).toEqual(['u3', 'u4']);
  });

  it('rejects the batch and rolls its transaction back when an awaited audit write of its operations fails', async () => {
    const events: string[] = [];
    const writeError = new Error('audit table unavailable');
    const observer = vi.fn();
    const deps = createDeps(loggingWrite(events, writeError), createFailureSink({ observer }));
    const { provider, proxy } = batchProxy(events, deps);

    const outcome = await settled(
      provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.create(create('u1', true))])),
    );

    expect(outcome).toBe('rejected');
    expect(events).toEqual(['started u1']);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'log-write', error: writeError }));
  });

  it("resolves the caller's committed batch when an audit write it does not await fails", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: string[] = [];
    const writeError = new Error('audit table unavailable');
    const observer = vi.fn();
    const deps = createDeps(loggingWrite(events, writeError), createFailureSink({ observer }));
    const { provider, proxy } = batchProxy(events, deps);

    try {
      const outcome = await settled(
        provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.create(create('u1', false))])),
      );

      expect(outcome).toBe('resolved');
      expect(events).toEqual(['committed', 'started u1']);
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'log-write', error: writeError }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
