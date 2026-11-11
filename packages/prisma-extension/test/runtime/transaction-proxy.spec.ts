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
 * - the audit writes of an operation inside a transaction, deferred ones included, run in the
 *   transaction before the operation returns, so they commit and roll back with it;
 * - a callback that resolves after an audit failure failed one of its operations is rolled back.
 *
 * The specs observe the runtime as an audited operation does: an operation run through the
 * audited pipeline takes its transaction from the binding it starts with and writes its audit
 * through a fake writer.
 */

import {
  type AuditActor,
  type AuditContext,
  type AuditObserver,
  type AuditRecord,
  AuditRollbackError,
  createActorId,
  createAggregateId,
  createAsyncLocalStorageProvider,
  createEntityId,
  createOperationOutcome,
  planFor,
  settledIn,
  type WriteMode,
} from '@kuruwic/db-audit-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaBaseClient, PrismaHandle } from '../../src/internal-types.js';
import type { OperationTransaction } from '../../src/pipeline/execution-scope.js';
import type { OperationExecutor } from '../../src/pipeline/executor.js';
import { type AuditPipelineDependencies, runAuditedOperation } from '../../src/pipeline/run-audited-operation.js';
import { createExtensionCheckpoints } from '../../src/runtime/extension-checkpoint.js';
import type { RecipeConfig } from '../../src/runtime/operation-recipe.js';
import { flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
import { currentScope, operationBinding, type RuntimeScope } from '../../src/runtime/scope.js';
import { createTransactionProxy } from '../../src/runtime/transaction-proxy.js';
import { loadSchemaMetadata } from '../../src/schema/schema-metadata.js';
import type { AuditLogData } from '../../src/types.js';
import { auditSchema, column, model } from '../support/audit-schema.js';
import { lazyOperation } from '../support/lazy-operation.js';

const actor1: AuditActor = { category: 'model', type: 'User', id: 'user-1' };
const actor2: AuditActor = { category: 'model', type: 'User', id: 'user-2' };

const baseContext: AuditContext = { actor: actor1, request: { ipAddress: '10.0.0.1' } };

/** The client the audited pipeline writes on outside any transaction; an audit that opens a transaction fails */
const auditedClient: PrismaBaseClient = {
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

/** The observer the outcomes of the operations run with each `deps` are reported to */
const observers = new WeakMap<AuditPipelineDependencies, AuditObserver>();

const createDeps = (write: AuditWrite, observer?: AuditObserver): AuditPipelineDependencies => {
  const deps: AuditPipelineDependencies = {
    singleExecutor: creatingExecutor,
    batchExecutor: creatingExecutor,
    produceRecords: vi.fn(async () => []),
    dispatchConfig: { writeExecutor: { write: vi.fn(write) } },
  };
  if (observer) {
    observers.set(deps, observer);
  }
  return deps;
};

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
 * transaction the operation runs in is the one its binding names, on the level open when it
 * starts, `query` continues the operation, and its outcome is settled with that level
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
        const outcome = createOperationOutcome(
          { model: 'User', operation: 'create', isolation: { kind: 'undeclared' } },
          { observer: observers.get(deps) },
        );
        const run = (inTransaction: OperationTransaction | undefined) =>
          settledIn(inTransaction?.audit, outcome, () =>
            runAuditedOperation(
              {
                operation: {
                  model: 'User',
                  action: 'create',
                  args: { id: args.id },
                  query: async () => {
                    if (args.fails) throw new Error(`Unique constraint failed: ${args.id}`);
                    return args;
                  },
                  reachedDatabase: () => false,
                  widened: new Map(),
                },
                auditContext: baseContext,
                issuingClient: auditedClient,
                mode,
                plan,
                transaction: inTransaction,
                outcome,
              },
              deps,
            ),
          );
        return transaction
          ? transaction.runOperation((audit) => run({ client: transaction.client, audit }))
          : run(undefined);
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
  modelOfDelegateProperty: new Map([['user', 'User']]),
  relatedModel: () => undefined,
  isAtomicWrite: () => atomic,
  atomicIsolationLevel: undefined,
});

const recipeConfig = recipeConfigAtomic(false);

const checkpoints = createExtensionCheckpoints(
  loadSchemaMetadata(auditSchema(model('User', [column('id', { isId: true })]))),
);

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
    modelOfDelegateProperty: new Map(),
    relatedModel: () => undefined,
    isAtomicWrite: () => false,
    atomicIsolationLevel: undefined,
  };

  it('returns every property other than $transaction, $extends and the wrapped operations as the client holds it', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, {
      provider: createAsyncLocalStorageProvider(),
      recipeConfig: noModels,
      checkpoints,
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
      checkpoints,
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
      checkpoints,
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
    return {
      provider,
      proxy: createTransactionProxy(target, { provider, recipeConfig, checkpoints }),
      tx,
      ran,
      $transaction,
    };
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
    expect(bindingOf(ran[0])).toEqual({ transaction: undefined, client: proxy });
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

  it('proxies a client derived by $extends, so that its interactive $transaction hands the callback a bound client and an operation on it outside any transaction is bound to it', async () => {
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
    const proxy = createTransactionProxy(target, { provider, recipeConfig, checkpoints });

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
    expect(bindingOf(ran[1])).toEqual({ transaction: undefined, client: derived });
    expect(Reflect.get(Object(bindingOf(ran[1])), 'client')).toBe(derived);
  });
});

describe('createTransactionProxy (a transaction nested in the one a callback runs in)', () => {
  /** A client whose transaction client opens, by its own `$transaction`, a nested one on `nestedTx` */
  const nestingProxy = () => {
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const nestedTx = probeClientNamed('nested transaction', ran);
    const tx = { ...probeClientNamed('transaction', ran), $transaction: transactionOf<ProbeClient>(nestedTx) };
    const target = { ...probeClientNamed('client', ran), $transaction: transactionOf(tx) };
    return {
      provider,
      proxy: createTransactionProxy(target, { provider, recipeConfig, checkpoints }),
      tx,
      nestedTx,
      ran,
    };
  };

  it('opens it on the transaction client and hands its callback a client bound to it', async () => {
    const { provider, proxy, tx, nestedTx, ran } = nestingProxy();
    let auditsWhileNested: unknown[] = [];

    await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await bound.$transaction(async (nested) => {
          await nested.user.create({ email: 'a' });
          await bound.user.findMany();
          auditsWhileNested = ran.map((probed) => bindingOf(probed)?.transaction?.audit);
        });
      }),
    );

    expect(tx.$transaction).toHaveBeenCalledTimes(1);
    expect(ran.map(({ action, client }) => ({ action, client }))).toEqual([
      { action: 'create', client: 'nested transaction' },
      { action: 'findMany', client: 'transaction' },
    ]);
    expect(transactionClientOf(ran[0])).toBe(nestedTx);
    expect(new Set(auditsWhileNested).size).toBe(1);
  });

  it('runs a batch $transaction of the bound client as a nested transaction, its operations in order', async () => {
    const { provider, proxy, tx, nestedTx, ran } = nestingProxy();

    await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await bound.$transaction([bound.user.findMany(), bound.user.create({ email: 'a' })]);
      }),
    );

    expect(tx.$transaction).toHaveBeenCalledTimes(1);
    expect(ran.map(({ action, client }) => ({ action, client }))).toEqual([
      { action: 'findMany', client: 'nested transaction' },
      { action: 'create', client: 'nested transaction' },
    ]);
    expect(ran.map(transactionClientOf)).toEqual([nestedTx, nestedTx]);
  });

  it('leaves the $transaction of a transaction client that has none, as before Prisma 7.5, as the client holds it', async () => {
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const tx = probeClientNamed('transaction', ran);
    const proxy = createTransactionProxy(
      { ...probeClientNamed('client', ran), $transaction: transactionOf<ProbeClient>(tx) },
      { provider, recipeConfig, checkpoints },
    );
    let nestedTransaction: unknown = 'unread';

    await proxy.$transaction(async (bound) => {
      nestedTransaction = Reflect.get(bound, '$transaction');
    });

    expect(nestedTransaction).toBeUndefined();
  });
});

describe('createTransactionProxy ($extends with an extension function)', () => {
  it('hands the function the audited client, so that an operation the extension issues on it is bound', async () => {
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const target = {
      ...probeClientNamed('client', ran),
      $transaction: transactionOf<ProbeClient>(probeClientNamed('transaction', ran)),
      $extends: (extension: unknown) => (typeof extension === 'function' ? extension(target) : target),
    };
    const proxy = createTransactionProxy(target, { provider, recipeConfig, checkpoints });
    let received: unknown;

    proxy.$extends((client: ProbeClient) => {
      received = client;
      return client;
    });
    await provider.runAsync(baseContext, async () => {
      await (received as ProbeClient).user.create({});
    });

    expect(received).toBe(proxy);
    expect(bindingOf(ran[0])).toEqual({ transaction: undefined, client: proxy });
  });
});

describe('createTransactionProxy ($extends with an extension object)', () => {
  const levelOf = (name: string, parent: object | undefined, applied: unknown[], ran: Probed[]): object => {
    const level: object = {
      ...probeClientNamed(name, ran),
      $parent: parent,
      $extends: (extension: unknown) => {
        if (typeof extension === 'function') {
          return extension(level);
        }
        applied.push(extension);
        return levelOf(`${name}+`, level, applied, ran);
      },
    };
    return level;
  };
  type Extendable = ProbeClient & { $extends: (extension: unknown) => Extendable; $parent: unknown };
  const isExtendable = (value: unknown): value is Extendable =>
    typeof value === 'object' && value !== null && typeof Reflect.get(value, '$extends') === 'function';
  const extendable = (value: unknown): Extendable => {
    if (!isExtendable(value)) {
      throw new Error('the client has no $extends');
    }
    return value;
  };

  const withQuery = (name: string) => ({ name, query: { $allOperations: () => undefined } });

  const auditedLevels = () => {
    const applied: unknown[] = [];
    const ran: Probed[] = [];
    const provider = createAsyncLocalStorageProvider();
    const below = levelOf('below', undefined, applied, ran);
    const proxy = extendable(
      createTransactionProxy(levelOf('audited', below, applied, ran), { provider, recipeConfig, checkpoints }),
    );
    const checkpointOn = async (client: Extendable) => {
      ran.length = 0;
      await provider.runAsync(baseContext, async () => {
        await client.user.create({});
      });
      return bindingOf(ran[0])?.checkpoint;
    };
    return { applied, proxy, checkpointOn };
  };

  it('applies an extension with query as it is, then its checkpoint on the client it derives, which is the client returned and has the client the extension was applied to as $parent', () => {
    const { applied, proxy } = auditedLevels();
    const extension = withQuery('encoding');

    const derived = proxy.$extends(extension);

    expect(applied).toHaveLength(2);
    expect(applied[0]).toBe(extension);
    expect(applied[1]).toMatchObject({ name: 'prisma-audit-checkpoint' });
    expect(derived.marker).toBe('the audited++ client');
    expect(derived.$parent).toBe(proxy);
  });

  it('binds an operation of a client an extension with query derives with the checkpoint after that extension, which leads to the checkpoints before it', async () => {
    const { proxy, checkpointOn } = auditedLevels();

    const derived = proxy.$extends(withQuery('first')).$extends(withQuery('second'));

    expect(await checkpointOn(proxy)).toBeUndefined();
    expect(await checkpointOn(derived)).toEqual({
      extensionName: 'second',
      previous: { extensionName: 'first', previous: undefined },
    });
  });

  it('places a checkpoint after an extension with query an extension function applies', async () => {
    const { proxy, checkpointOn } = auditedLevels();

    const derived = proxy.$extends((client: Extendable) => client.$extends(withQuery('through-a-function')));

    expect(await checkpointOn(extendable(derived))).toEqual({
      extensionName: 'through-a-function',
      previous: undefined,
    });
  });

  it('places no checkpoint after an extension without query, whose client keeps the checkpoint of the client it was derived from', async () => {
    const { applied, proxy, checkpointOn } = auditedLevels();
    const checked = proxy.$extends(withQuery('first'));

    const derived = checked.$extends({ name: 'methods', model: { user: { greet: () => 'hello' } } });

    expect(applied).toHaveLength(3);
    expect(await checkpointOn(derived)).toEqual({ extensionName: 'first', previous: undefined });
    expect(derived.$parent).toBe(checked);
  });

  it('places no checkpoint after an extension with query applied to a client below the audit', () => {
    const { applied, proxy } = auditedLevels();
    const below = extendable(proxy.$parent);
    const extension = withQuery('below-the-audit');

    below.$extends(extension);

    expect(applied).toEqual([extension]);
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
      proxy: createTransactionProxy(target, { provider, recipeConfig: recipe, checkpoints }),
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

  it.each([
    { declared: 'RepeatableRead', options: [{ isolationLevel: 'RepeatableRead' }] },
    { declared: undefined, options: [] },
  ])(
    'opens the transaction of an atomic write at the isolation level the config declares ($declared), which the transaction records',
    async ({ declared, options }) => {
      const { provider, proxy, ran, $transaction } = createRecipeProxy({
        ...recipeConfigAtomic(true),
        atomicIsolationLevel: declared,
      });

      await provider.runAsync(baseContext, async () => await proxy.user.create({ email: 'a' }));

      expect($transaction.mock.calls.map((call) => call.slice(1))).toEqual([options]);
      expect(ran.map((probed) => bindingOf(probed)?.transaction?.isolationLevel)).toEqual([declared]);
    },
  );

  it('runs a call that is not an atomic write on the client itself, bound to no transaction', async () => {
    const { provider, proxy, ran, $transaction } = createRecipeProxy(recipeConfigAtomic(false));

    await provider.runAsync(baseContext, async () => await proxy.user.create({ email: 'a' }));

    expect($transaction).not.toHaveBeenCalled();
    expect(ran.map(({ client }) => client)).toEqual(['client']);
    expect(ran.map(bindingOf)).toEqual([{ transaction: undefined, client: proxy }]);
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
        expect(ran[0]?.scope).toEqual({ binding: { transaction: undefined, client: proxy } });
      },
    );
  });
});

describe('createTransactionProxy (deferred audit writes inside a transaction)', () => {
  /** A proxy over a client whose operations run the audited pipeline, and whose interactive transactions are settled by `settle` */
  const auditedProxy = (deps: AuditPipelineDependencies, settle?: Parameters<typeof transactionOf>[1]) => {
    const tx = auditedClientOf(deps);
    const provider = createAsyncLocalStorageProvider();
    const target = { ...auditedClientOf(deps), $transaction: transactionOf(tx, settle) };
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig, checkpoints }), tx };
  };

  it('writes the audit of a deferred operation run under an actor override in the transaction, before the operation returns and before the transaction commits', async () => {
    const deps = createDeps(async () => {});
    let writesAtCommitTime = -1;
    const { provider, proxy, tx } = auditedProxy(deps, async (runCallback) => {
      const callbackResult = await runCallback();
      writesAtCommitTime = auditWriteOf(deps).mock.calls.length;
      return callbackResult;
    });
    let writesInsideTransaction = -1;

    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await provider.withActor(actor2, () => bound.user.create({ id: 'u1', atomic: false }));
        writesInsideTransaction = auditWriteOf(deps).mock.calls.length;
        return 'committed';
      }),
    );

    expect(result).toBe('committed');
    expect(writesInsideTransaction).toBe(1);
    expect(writesAtCommitTime).toBe(1);
    expect(getPendingWriteCount()).toBe(0);
    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(tx, [recordOf('u1')]);
  });

  it('writes the audit of a deferred operation only in the transaction, which rolls it back when the callback throws', async () => {
    const deps = createDeps(async () => {});
    const { provider, proxy, tx } = auditedProxy(deps);

    await expect(
      provider.runAsync(baseContext, () =>
        proxy.$transaction(async (bound) => {
          await provider.runAsync({ actor: actor2 }, async () => await bound.user.create({ id: 'u1', atomic: false }));
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');
    await flushAllPendingWrites();

    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(tx, [recordOf('u1')]);
  });

  it('writes the audit of a deferred operation only in the transaction, which rolls it back when the commit fails', async () => {
    const deps = createDeps(async () => {});
    const { provider, proxy, tx } = auditedProxy(deps, async (runCallback) => {
      await runCallback();
      throw new Error('commit failed');
    });

    await expect(
      provider.runAsync(baseContext, () =>
        proxy.$transaction(async (bound) => {
          await bound.user.create({ id: 'u1', atomic: false });
          return 'callback-ok';
        }),
      ),
    ).rejects.toThrow('commit failed');
    await flushAllPendingWrites();

    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(tx, [recordOf('u1')]);
  });
});

describe('createTransactionProxy (audit failures recorded on the transaction)', () => {
  const writeError = new Error('audit table unavailable');

  const depsFailingFor = (bad: string) =>
    createDeps(async (_handle, records) => {
      if (records.some((written) => written.entityId === bad)) throw writeError;
    });

  const auditedProxy = (deps: AuditPipelineDependencies) => {
    const tx = auditedClientOf(deps);
    const provider = createAsyncLocalStorageProvider();
    const target = { ...auditedClientOf(deps), $transaction: transactionOf(tx) };
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig, checkpoints }), tx };
  };

  it('rejects $transaction with an AuditRollbackError when the callback resolves after an operation failed on its audit', async () => {
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
    expect(auditWriteOf(deps).mock.calls).toEqual([
      [tx, [recordOf('u1')]],
      [tx, [recordOf('bad')]],
    ]);
  });

  it('resolves normally when no audit failure was recorded on the transaction', async () => {
    const deps = depsFailingFor('bad');
    const { provider, proxy } = auditedProxy(deps);

    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async (bound) => {
        await bound.user.create({ id: 'u1', atomic: false });
        await bound.user.create({ id: 'u2', atomic: true });
        return 'committed';
      }),
    );

    expect(result).toBe('committed');
    expect(writtenIds(deps)).toEqual(['u1', 'u2']);
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
    let innerRejection: unknown;

    // The inner transaction rolls back for the audit failure; the outer callback catches that
    // rejection, and its own transaction commits.
    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async () => {
        innerRejection = await proxy
          .$transaction(async (inner) => {
            await inner.user.create({ id: 'bad', atomic: true }).then(undefined, () => undefined);
          })
          .then(
            () => undefined,
            (rejection: unknown) => rejection,
          );
        return 'outer committed';
      }),
    );

    expect(innerRejection).toBeInstanceOf(AuditRollbackError);
    expect(innerRejection).toHaveProperty('cause', writeError);
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
    return { provider, proxy: createTransactionProxy(target, { provider, recipeConfig, checkpoints }), tx };
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

  it.each([
    { mode: 'atomic', atomic: true },
    { mode: 'deferred', atomic: false },
  ])(
    'writes the audit of a $mode operation by the transaction, one operation after another, and resolves the batch once they have finished',
    async ({ atomic }) => {
      const events: string[] = [];
      const deps = createDeps(loggingWrite(events));
      const { provider, proxy, tx } = batchProxy(events, deps);

      const outcome = await settled(
        provider
          .runAsync(baseContext, () =>
            proxy.$transaction([proxy.user.create(create('u1', atomic)), proxy.user.create(create('u2', atomic))]),
          )
          .then((result) => {
            events.push('resolved');
            return result;
          }),
      );

      expect(outcome).toBe('resolved');
      expect(events).toEqual(['started u1', 'written u1', 'started u2', 'written u2', 'committed', 'resolved']);
      expect(auditWriteOf(deps).mock.calls.map(([handle]) => handle)).toEqual([tx, tx]);
    },
  );

  it.each([
    { mode: 'atomic', atomic: true },
    { mode: 'deferred', atomic: false },
  ])(
    'leaves the audit of a $mode operation to the transaction when a later operation of the batch fails and the batch rolls back: it was written on the transaction client',
    async ({ atomic }) => {
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
      expect(writtenIds(deps)).toEqual(['u1']);
      for (const [handle] of auditWriteOf(deps).mock.calls) {
        expect(handle).toBe(tx);
      }
    },
  );

  it('keeps the audits of two batches running at once apart: the outcomes of the one that rolls back are not committed', async () => {
    const events: string[] = [];
    const observer = vi.fn<AuditObserver>();
    const deps = createDeps(loggingWrite(events), observer);
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
    expect(writtenIds(deps).sort()).toEqual(['u1', 'u3', 'u4']);
    expect(observer.mock.calls.map(([outcome]) => outcome.status).sort()).toEqual([
      'complete',
      'complete',
      'not-committed',
      'not-committed',
    ]);
  });

  it.each([
    { mode: 'atomic', atomic: true },
    { mode: 'deferred', atomic: false },
  ])(
    'rejects the batch and rolls its transaction back when the audit write of a $mode operation fails',
    async ({ atomic }) => {
      const events: string[] = [];
      const writeError = new Error('audit table unavailable');
      const observer = vi.fn();
      const deps = createDeps(loggingWrite(events, writeError), observer);
      const { provider, proxy } = batchProxy(events, deps);

      const outcome = await settled(
        provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.create(create('u1', atomic))])),
      );

      expect(outcome).toBe('rejected');
      expect(events).toEqual(['started u1']);
      expect(observer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: 'not-committed',
          failures: [expect.objectContaining({ phase: 'log-write', error: writeError })],
        }),
      );
    },
  );
});
