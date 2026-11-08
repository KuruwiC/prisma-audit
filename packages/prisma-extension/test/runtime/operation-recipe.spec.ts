/**
 * Tests for operation recipes: when a recipe runs, on which client, which transaction it is bound
 * to, how a batch takes it, what `$parent` is, and which calls of a client below the audit are
 * rejected: every model write, decided from the client's outer client and the call's action alone.
 */

import { RejectedWriteError } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { AuditParentWriteError } from '../../src/errors.js';
import type { OpenTransaction } from '../../src/runtime/interactive-transaction.js';
import { createRecipeClient, type RecipeConfig, takeBatchRecipes } from '../../src/runtime/operation-recipe.js';
import { currentScope, withScope } from '../../src/runtime/scope.js';
import { activeTransactionOf } from '../support/active-transaction.js';
import { lazyOperation } from '../support/lazy-operation.js';

interface Ran {
  readonly client: string;
  /** Whether the client the call was made on bound the operation when it started */
  readonly bound: boolean;
  readonly transactionClient: unknown;
}

/**
 * An audited client (`receiver`) and the client behind it (`target`), whose `user.create` records
 * the client it ran on and the binding the runtime scope held then. `openTransaction` runs its
 * body in a transaction whose client is `tx`.
 */
const createClients = () => {
  const ran: Ran[] = [];
  const clientNamed = (name: string) => ({
    user: {
      create: (args: unknown) =>
        lazyOperation(() => {
          const binding = currentScope()?.binding;
          ran.push({
            client: name,
            bound: binding !== undefined,
            transactionClient: binding?.transaction?.client,
          });
          return { created: args };
        }),
    },
  });
  const tx = clientNamed('transaction');
  const openTransaction = vi.fn<OpenTransaction>(async (_client, _options, bind, body) =>
    body(activeTransactionOf(tx, bind)),
  );
  const receiver = {};
  const target = clientNamed('client');
  return { receiver, target, tx, ran, openTransaction };
};

/** A config by which every call of `user` is an atomic write when `atomic` */
const configAtomic = (atomic: boolean): RecipeConfig => ({
  modelOfDelegateProperty: new Map([['user', 'User']]),
  relatedModel: () => undefined,
  isAtomicWrite: vi.fn(() => atomic),
  atomicIsolationLevel: undefined,
});

/** Leaves a client the delegates' `$parent` names as it is: these tests never read it */
const unwrapped = (client: object): object => client;

/** Tells that every client carries the audit hook: these tests issue no call below it */
const everyAudited = (): boolean => true;

const noneAudited = (): boolean => false;

/** Leaves the `$transaction` of a client as it is: these tests never call it */
const ownTransaction = (_issuer: unknown, original: (...args: unknown[]) => unknown) => original;

type UserDelegate = { create: (args: unknown) => PromiseLike<unknown> };

/** `receiver.user.create(args)` as the client proxy returns it */
const createUserOn = (
  config: RecipeConfig,
  clients: ReturnType<typeof createClients>,
  args: unknown,
  carriesAudit: (client: object) => boolean = everyAudited,
) => {
  const delegate = createRecipeClient(
    config,
    clients.openTransaction,
    unwrapped,
    carriesAudit,
    ownTransaction,
  ).propertyOf(clients.receiver, clients.target, 'user')?.value as UserDelegate;
  return delegate.create(args);
};

describe('operation recipes', () => {
  it('runs an atomic write in a transaction of its own, opened on the client it was made on, even inside a transaction of the caller', async () => {
    const clients = createClients();
    const callerTransaction = activeTransactionOf({ _caller: true });

    await withScope({ binding: { transaction: callerTransaction } }, async () => {
      await createUserOn(configAtomic(true), clients, { email: 'a' });
    });

    expect(clients.openTransaction).toHaveBeenCalledTimes(1);
    expect(clients.openTransaction.mock.calls[0]?.[0]).toBe(clients.target);
    expect(clients.ran).toEqual([{ client: 'transaction', bound: true, transactionClient: clients.tx }]);
  });

  it('binds an operation of a client outside any transaction to no transaction, whatever transaction it is awaited in', async () => {
    const clients = createClients();
    const callerTransaction = activeTransactionOf({ _caller: true });

    await withScope({ binding: { transaction: callerTransaction } }, async () => {
      await createUserOn(configAtomic(false), clients, { email: 'a' });
    });

    expect(clients.openTransaction).not.toHaveBeenCalled();
    expect(clients.ran).toEqual([{ client: 'client', bound: true, transactionClient: undefined }]);
  });

  describe('the client bound to a transaction the client opens', () => {
    const inTransactionOf = (
      clients: ReturnType<typeof createClients>,
      config: RecipeConfig,
      body: (bound: Record<string, unknown>) => Promise<unknown>,
    ) =>
      createRecipeClient(config, clients.openTransaction, unwrapped, everyAudited, ownTransaction).openTransactionOn(
        {
          receiver: clients.receiver,
          target: clients.target,
          transaction: undefined,
          outerClient: clients.target,
          belowAudit: false,
        },
        [],
        (transaction) => body(transaction.boundClient),
      );

    it('binds its operations to the transaction, and opens none for an atomic write', async () => {
      const clients = createClients();

      await inTransactionOf(clients, configAtomic(true), async (bound) => {
        await (bound.user as UserDelegate).create({ email: 'a' });
      });

      expect(clients.openTransaction).toHaveBeenCalledTimes(1);
      expect(clients.openTransaction).toHaveBeenCalledWith(
        clients.target,
        [],
        expect.any(Function),
        expect.any(Function),
        undefined,
      );
      expect(clients.ran).toEqual([{ client: 'transaction', bound: true, transactionClient: clients.tx }]);
    });

    it("returns every other property as the transaction's client holds it", async () => {
      const clients = createClients();
      const marker = { marker: true };
      Reflect.set(clients.tx, '$other', marker);

      await inTransactionOf(clients, configAtomic(false), async (bound) => {
        expect(bound.$other).toBe(marker);
        expect(bound.user).toBe(bound.user);
      });
    });
  });

  describe('the $parent of a client and of its model delegates', () => {
    /**
     * The clients of `createClients`, `target` and its transaction client each with a `$parent`
     * (`below`, and `belowTransaction`, the transaction client of `below`), and a recipe client by
     * which `target` carries the audit hook, and `below` does when `belowAudited`
     */
    const parentClients = (belowAudited: boolean) => {
      const clients = createClients();
      const below = { below: true };
      const belowTransaction = {
        user: {
          create: (args: unknown) =>
            lazyOperation(() => {
              clients.ran.push({
                client: 'transaction below',
                bound: currentScope()?.binding !== undefined,
                transactionClient: currentScope()?.binding?.transaction?.client,
              });
              return { created: args };
            }),
        },
      };
      Reflect.set(clients.target, '$parent', below);
      Reflect.set(clients.target.user, '$parent', below);
      Reflect.set(clients.tx, '$parent', belowTransaction);
      Reflect.set(clients.tx.user, '$parent', belowTransaction);
      const wrappedBelow = { wrapped: true };
      const clientOf = vi.fn((_client: object): object => wrappedBelow);
      const recipeClient = createRecipeClient(
        configAtomic(false),
        clients.openTransaction,
        clientOf,
        (client) => client === clients.target || (belowAudited && client === below),
        ownTransaction,
      );
      const parentsOf = (client: object, delegate: unknown) => [
        Reflect.get(client, '$parent'),
        Reflect.get(delegate as object, '$parent'),
      ];
      const outside = () => {
        const user = recipeClient.propertyOf(clients.receiver, clients.target, 'user')?.value;
        return [
          recipeClient.propertyOf(clients.receiver, clients.target, '$parent')?.value,
          Reflect.get(user as object, '$parent'),
        ];
      };
      const inTransaction = <T>(body: (bound: Record<string, unknown>) => Promise<T>) =>
        recipeClient.openTransactionOn(
          {
            receiver: clients.receiver,
            target: clients.target,
            transaction: undefined,
            outerClient: clients.target,
            belowAudit: false,
          },
          [],
          (transaction) => body(transaction.boundClient),
        );
      return { clients, below, wrappedBelow, clientOf, outside, inTransaction, parentsOf };
    };

    it.each([true, false])(
      'is, outside any transaction, the one wrapper of the client below, read from the client or from one of its model delegates, whether or not that client carries the audit hook (%s)',
      (belowAudited) => {
        const { below, wrappedBelow, outside, clientOf } = parentClients(belowAudited);

        const [clientParent, delegateParent] = outside();
        expect(clientParent).toBe(wrappedBelow);
        expect(delegateParent).toBe(wrappedBelow);
        expect(clientOf).toHaveBeenCalledWith(below);
      },
    );

    it("is, inside a transaction, the client below's transaction client bound to it, read once per client, and a write through it runs bound when the client below carries the audit hook", async () => {
      const { clients, inTransaction, parentsOf } = parentClients(true);

      await inTransaction(async (bound) => {
        const [clientParent, delegateParent] = parentsOf(bound, bound.user);
        expect(clientParent).not.toBe(bound);
        expect(Reflect.get(bound, '$parent')).toBe(clientParent);
        await (delegateParent as { user: UserDelegate }).user.create({ email: 'a' });
      });

      expect(clients.ran).toEqual([{ client: 'transaction below', bound: true, transactionClient: clients.tx }]);
    });

    it("rejects, inside a transaction, a write through the client below's transaction client when the client below does not carry the audit hook", async () => {
      const { clients, inTransaction } = parentClients(false);

      await inTransaction(async (bound) => {
        const parent = Reflect.get(bound, '$parent') as { user: UserDelegate };
        await expect(parent.user.create({ email: 'a' })).rejects.toThrow(AuditParentWriteError);
      });

      expect(clients.ran).toEqual([]);
    });
  });

  describe('a call of a client below the audit', () => {
    it('rejects a model write with AuditParentWriteError before it runs, naming the model and action of the call, opening no transaction for it', async () => {
      const clients = createClients();

      const created = createUserOn(configAtomic(true), clients, { email: 'a' }, noneAudited);

      await expect(created).rejects.toThrow(AuditParentWriteError);
      await expect(created).rejects.toBeInstanceOf(RejectedWriteError);
      await expect(created).rejects.toMatchObject({
        modelName: 'User',
        operationModelName: 'User',
        operation: 'create',
      });
      expect(clients.openTransaction).not.toHaveBeenCalled();
      expect(clients.ran).toEqual([]);
    });

    it('rejects a model write with AuditParentWriteError while the audit processes an operation', async () => {
      const clients = createClients();

      await withScope({ withinAudit: true }, async () => {
        const created = createUserOn(configAtomic(false), clients, { email: 'a' }, noneAudited);
        await expect(created).rejects.toThrow(AuditParentWriteError);
      });

      expect(clients.ran).toEqual([]);
    });

    it('runs a read and a raw query, unbound to any transaction', async () => {
      const seen: { readonly call: string; readonly transaction: unknown }[] = [];
      const record = (call: string) => () => seen.push({ call, transaction: currentScope()?.binding?.transaction });
      const target = {
        user: { findMany: () => lazyOperation(record('findMany')) },
        $queryRaw: () => lazyOperation(record('$queryRaw')),
      };
      const recipeClient = createRecipeClient(
        configAtomic(false),
        vi.fn<OpenTransaction>(),
        unwrapped,
        noneAudited,
        ownTransaction,
      );
      const user = recipeClient.propertyOf({}, target, 'user')?.value as { findMany: () => PromiseLike<unknown> };
      const queryRaw = recipeClient.propertyOf({}, target, '$queryRaw')?.value as () => PromiseLike<unknown>;

      await withScope({ binding: { transaction: activeTransactionOf({ _caller: true }) } }, async () => {
        await user.findMany();
        await queryRaw();
      });

      expect(seen).toEqual([
        { call: 'findMany', transaction: undefined },
        { call: '$queryRaw', transaction: undefined },
      ]);
    });
  });

  it('decides once, from the arguments of its call, whether it is an atomic write, and runs it on the client itself when it is not', async () => {
    const clients = createClients();
    const config = configAtomic(false);

    await createUserOn(config, clients, { email: 'a' });

    expect(config.isAtomicWrite).toHaveBeenCalledTimes(1);
    expect(config.isAtomicWrite).toHaveBeenCalledWith('User', 'create', { email: 'a' });
    expect(clients.openTransaction).not.toHaveBeenCalled();
    expect(clients.ran).toEqual([{ client: 'client', bound: true, transactionClient: undefined }]);
  });

  it('runs a write on the client itself while the audit processes an operation', async () => {
    const clients = createClients();

    await withScope({ withinAudit: true }, async () => {
      await createUserOn(configAtomic(true), clients, { email: 'a' });
    });

    expect(clients.openTransaction).not.toHaveBeenCalled();
    expect(clients.ran).toEqual([{ client: 'client', bound: true, transactionClient: undefined }]);
  });

  it('runs once when awaited twice, both awaits receiving the one result', async () => {
    const clients = createClients();
    const created = createUserOn(configAtomic(false), clients, { email: 'a' });

    const first = await created;
    const second = await created;

    expect(clients.ran).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('replays a fluent relation call on the operation it follows, under the binding of that operation', async () => {
    const calls: unknown[] = [];
    const target = {
      user: {
        update: (args: unknown) => {
          calls.push(['update', args]);
          return {
            ...lazyOperation(() => ({ id: 'u1' })),
            posts: (postArgs: unknown) => {
              calls.push(['posts', postArgs]);
              return lazyOperation(() => ({ posts: postArgs, binding: currentScope()?.binding }));
            },
          };
        },
      },
    };
    const config: RecipeConfig = {
      ...configAtomic(false),
      relatedModel: (model, field) => (model === 'User' && field === 'posts' ? 'Post' : undefined),
    };
    const delegate = createRecipeClient(
      config,
      vi.fn<OpenTransaction>(),
      unwrapped,
      everyAudited,
      ownTransaction,
    ).propertyOf({}, target, 'user')?.value as {
      update: (args: unknown) => { posts: (args: unknown) => PromiseLike<unknown> };
    };

    const posts = await delegate.update({ where: { id: 'u1' }, data: {} }).posts({ take: 1 });

    expect(calls).toEqual([
      ['update', { where: { id: 'u1' }, data: {} }],
      ['posts', { take: 1 }],
    ]);
    expect(posts).toEqual({ posts: { take: 1 }, binding: { transaction: undefined } });
  });

  it('rejects when awaited after a batch has taken it, without running it', async () => {
    const clients = createClients();
    const created = createUserOn(configAtomic(true), clients, { email: 'a' });

    takeBatchRecipes([created], clients.receiver);

    await expect(Promise.resolve(created)).rejects.toThrow('given to a batch $transaction');
    expect(clients.ran).toEqual([]);
  });

  describe('a batch that cannot take every operation', () => {
    it.each([
      [
        'an item that is not an operation of an audited client',
        () => ({ then: () => undefined }),
        'was not created by an audited client',
      ],
      [
        'an operation of another client',
        () => createUserOn(configAtomic(false), createClients(), { email: 'b' }),
        'was created by another client than the one $transaction is called on',
      ],
    ])('rejects %s, taking none of the operations', async (_label, makeItem, problem) => {
      const clients = createClients();
      const config = configAtomic(false);
      const own = createUserOn(config, clients, { email: 'a' });

      expect(() => takeBatchRecipes([own, makeItem()], clients.receiver)).toThrow(
        `The operation at index 1 of the batch $transaction ${problem}`,
      );
      await own;
      expect(clients.ran).toHaveLength(1);
    });

    it('rejects an operation that has already run', async () => {
      const clients = createClients();
      const config = configAtomic(false);
      const created = createUserOn(config, clients, { email: 'a' });
      await created;

      expect(() => takeBatchRecipes([created], clients.receiver)).toThrow(
        'The operation at index 0 of the batch $transaction has already run',
      );
    });
  });

  describe('a raw-query method of the client', () => {
    const rawClient = () => {
      const queryRaw = vi.fn((...args: unknown[]) => lazyOperation(() => ({ rows: args })));
      const runCommandRaw = vi.fn((...args: unknown[]) => lazyOperation(() => ({ command: args })));
      return {
        receiver: {},
        target: { $queryRaw: queryRaw, $runCommandRaw: runCommandRaw },
        openTransaction: vi.fn<OpenTransaction>(),
      };
    };
    const rawMethodOf = (clients: ReturnType<typeof rawClient>, name: string, config = configAtomic(true)) =>
      createRecipeClient(config, clients.openTransaction, unwrapped, everyAudited, ownTransaction).propertyOf(
        clients.receiver,
        clients.target,
        name,
      )?.value as ((...args: unknown[]) => PromiseLike<unknown> & object) | undefined;

    it('returns a recipe that calls the method on the client behind it, with the arguments, when awaited', async () => {
      const clients = rawClient();

      const recipe = rawMethodOf(clients, '$queryRaw')?.(['SELECT 1'], 7);

      expect(clients.target.$queryRaw).not.toHaveBeenCalled();
      await expect(recipe).resolves.toEqual({ rows: [['SELECT 1'], 7] });
      expect(clients.target.$queryRaw).toHaveBeenCalledTimes(1);
      expect(clients.openTransaction).not.toHaveBeenCalled();
    });

    it('is a recipe no fluent relation follows and that is never an atomic write', async () => {
      const clients = rawClient();
      const config = configAtomic(true);
      const command = rawMethodOf(clients, '$runCommandRaw', config)?.({ ping: 1 }) as PromiseLike<unknown> & object;

      expect('posts' in command).toBe(false);
      await expect(command).resolves.toEqual({ command: [{ ping: 1 }] });
      expect(config.isAtomicWrite).not.toHaveBeenCalled();
      expect(clients.openTransaction).not.toHaveBeenCalled();
    });

    it('can be taken by a batch like the operation of a model, and runs on the client the batch gives', async () => {
      const clients = rawClient();
      const config = configAtomic(true);
      const recipe = rawMethodOf(clients, '$queryRaw', config)?.('SELECT 2');
      const other = { $queryRaw: vi.fn((...args: unknown[]) => lazyOperation(() => ({ other: args }))) };

      const batch = takeBatchRecipes([recipe], clients.receiver);

      expect(batch.holdsModelWrite).toBe(false);
      await expect(Promise.all(batch.operationsOn(other))).resolves.toEqual([{ other: ['SELECT 2'] }]);
      expect(clients.target.$queryRaw).not.toHaveBeenCalled();
    });

    it('is not wrapped when the client behind it has no such method, nor are other client methods', () => {
      const clients = rawClient();
      const recipeClient = createRecipeClient(
        configAtomic(true),
        clients.openTransaction,
        unwrapped,
        everyAudited,
        ownTransaction,
      );

      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$executeRaw')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$connect')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, Symbol.iterator)).toBeUndefined();
    });
  });

  describe('the operations a batch takes', () => {
    /** Deciding by action: creates are atomic writes, other calls are not */
    const decidingConfig = (): RecipeConfig => ({
      modelOfDelegateProperty: new Map([['user', 'User']]),
      relatedModel: () => undefined,
      isAtomicWrite: (_model, action) => action === 'create',
      atomicIsolationLevel: undefined,
    });
    interface Seen {
      readonly action: string;
      readonly bound: boolean;
      readonly transactionClient: unknown;
    }
    const userClient = (seen: Seen[]) => {
      const action = (name: string) => () =>
        lazyOperation(() => {
          const binding = currentScope()?.binding;
          seen.push({
            action: name,
            bound: binding !== undefined,
            transactionClient: binding?.transaction?.client,
          });
          return name;
        });
      return {
        user: {
          create: action('create'),
          update: action('update'),
          delete: action('delete'),
          findMany: action('findMany'),
          count: action('count'),
        },
      };
    };
    const recipesOn = (
      receiver: object,
      target: object,
      config: RecipeConfig,
      actions: string[],
      carriesAudit: (client: object) => boolean = everyAudited,
    ) => {
      const user = createRecipeClient(
        config,
        vi.fn<OpenTransaction>(),
        unwrapped,
        carriesAudit,
        ownTransaction,
      ).propertyOf(receiver, target, 'user')?.value as Record<string, () => PromiseLike<unknown>>;
      return actions.map((name) => user[name]?.() as PromiseLike<unknown>);
    };

    it('hold a write when one of them is a model write, whether or not the audit records it', () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['findMany', 'delete']);

      expect(takeBatchRecipes(items, receiver).holdsModelWrite).toBe(true);
    });

    it('hold no write when each of them is a read', () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['findMany', 'count']);

      expect(takeBatchRecipes(items, receiver).holdsModelWrite).toBe(false);
    });

    it('are rejected, none of them taken, when one of them is a model write a client below the audit made', async () => {
      const receiver = {};
      const seen: Seen[] = [];
      const items = recipesOn(receiver, userClient(seen), decidingConfig(), ['findMany', 'update'], noneAudited);

      expect(() => takeBatchRecipes(items, receiver)).toThrow(AuditParentWriteError);
      await items[0];
      expect(seen).toEqual([{ action: 'findMany', bound: true, transactionClient: undefined }]);
    });

    it('hold no write for an empty batch', () => {
      expect(takeBatchRecipes([], {}).holdsModelWrite).toBe(false);
    });

    it("start on the client given for Prisma's own batch, each without a binding", async () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['findMany', 'count']);
      const seen: Seen[] = [];

      const operations = takeBatchRecipes(items, receiver).operationsOn(userClient(seen));
      await withScope({ binding: { transaction: activeTransactionOf({ _caller: true }) } }, () =>
        Promise.all(operations as PromiseLike<unknown>[]),
      );

      expect(seen).toEqual([
        { action: 'findMany', bound: false, transactionClient: undefined },
        { action: 'count', bound: false, transactionClient: undefined },
      ]);
    });

    it("run one after another on the transaction's client, each bound to it, an atomic write without a transaction of its own", async () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['create', 'update', 'delete']);
      const seen: Seen[] = [];
      const txClient = userClient(seen);

      const results = await takeBatchRecipes(items, receiver).runIn(activeTransactionOf(txClient));

      expect(results).toEqual(['create', 'update', 'delete']);
      expect(seen).toEqual([
        { action: 'create', bound: true, transactionClient: txClient },
        { action: 'update', bound: true, transactionClient: txClient },
        { action: 'delete', bound: true, transactionClient: txClient },
      ]);
    });
  });

  it('answers in and Symbol.toStringTag as a promise of its own kind, with its fluent relations', () => {
    const clients = createClients();
    const config: RecipeConfig = {
      ...configAtomic(true),
      relatedModel: (model, field) => (model === 'User' && field === 'posts' ? 'Post' : undefined),
    };
    const created = createUserOn(config, clients, { email: 'a' });

    expect('then' in created).toBe(true);
    expect('catch' in created).toBe(true);
    expect('finally' in created).toBe(true);
    expect('posts' in created).toBe(true);
    expect('comments' in created).toBe(false);
    expect(Object.prototype.toString.call(created)).toBe('[object PrismaAuditOperation]');
  });
});
