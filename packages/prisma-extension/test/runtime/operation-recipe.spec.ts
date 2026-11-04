/**
 * Tests for operation recipes: when a recipe runs, on which client, which transaction it is bound
 * to, and how a batch takes it.
 */

import { describe, expect, it, vi } from 'vitest';
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
  const openTransaction = vi.fn<OpenTransaction>(async (_client, _options, body) => body(activeTransactionOf(tx)));
  const receiver = {};
  const target = clientNamed('client');
  return { receiver, target, tx, ran, openTransaction };
};

/** A config by which every call of `user` is an atomic write when `atomic` */
const configAtomic = (atomic: boolean): RecipeConfig => ({
  modelOfAccessor: new Map([['user', 'User']]),
  relatedModel: () => undefined,
  isAtomicWrite: vi.fn(() => atomic),
});

type UserDelegate = { create: (args: unknown) => PromiseLike<unknown> };

/** `receiver.user.create(args)` as the client proxy returns it */
const createUserOn = (config: RecipeConfig, clients: ReturnType<typeof createClients>, args: unknown) => {
  const delegate = createRecipeClient(config, clients.openTransaction).propertyOf(
    clients.receiver,
    clients.target,
    'user',
  )?.value as UserDelegate;
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

  describe('the client a $transaction callback receives', () => {
    it('binds its operations to the transaction, and opens none for an atomic write', async () => {
      const clients = createClients();
      const transaction = activeTransactionOf(clients.tx);
      const bound = createRecipeClient(configAtomic(true), clients.openTransaction).boundClient(transaction);

      await (bound.user as UserDelegate).create({ email: 'a' });

      expect(clients.openTransaction).not.toHaveBeenCalled();
      expect(clients.ran).toEqual([{ client: 'transaction', bound: true, transactionClient: clients.tx }]);
    });

    it("returns every other property as the transaction's client holds it", () => {
      const clients = createClients();
      const marker = { marker: true };
      const transaction = activeTransactionOf({ ...clients.tx, $other: marker });
      const bound = createRecipeClient(configAtomic(false), clients.openTransaction).boundClient(transaction);

      expect(bound.$other).toBe(marker);
      expect(bound.user).toBe(bound.user);
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

    await withScope({ isProcessingAuditLog: true }, async () => {
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
    const delegate = createRecipeClient(config, vi.fn<OpenTransaction>()).propertyOf({}, target, 'user')?.value as {
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
      createRecipeClient(config, clients.openTransaction).propertyOf(clients.receiver, clients.target, name)?.value as
        | ((...args: unknown[]) => PromiseLike<unknown> & object)
        | undefined;

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
      const recipeClient = createRecipeClient(configAtomic(true), clients.openTransaction);

      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$executeRaw')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$connect')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, Symbol.iterator)).toBeUndefined();
    });
  });

  describe('the operations a batch takes', () => {
    /** Deciding by action: creates are atomic writes, other calls are not */
    const decidingConfig = (): RecipeConfig => ({
      modelOfAccessor: new Map([['user', 'User']]),
      relatedModel: () => undefined,
      isAtomicWrite: (_model, action) => action === 'create',
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
    const recipesOn = (receiver: object, target: object, config: RecipeConfig, actions: string[]) => {
      const user = createRecipeClient(config, vi.fn<OpenTransaction>()).propertyOf(receiver, target, 'user')
        ?.value as Record<string, () => PromiseLike<unknown>>;
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
