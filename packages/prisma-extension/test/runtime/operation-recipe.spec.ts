/**
 * Tests for operation recipes: when a recipe runs, on which client, which transaction it is bound
 * to, and how a batch takes it.
 */

import type { WritePolicy } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { OpenTransaction } from '../../src/runtime/interactive-transaction.js';
import { createRecipeClient, type RecipeConfig, takeBatchRecipes } from '../../src/runtime/operation-recipe.js';
import { currentScope, decidedWritePolicyFor, withScope } from '../../src/runtime/scope.js';
import { activeTransactionOf } from '../support/active-transaction.js';
import { lazyOperation } from '../support/lazy-operation.js';

interface Ran {
  readonly client: string;
  /** Whether the client the call was made on bound the operation when it started */
  readonly bound: boolean;
  readonly transactionClient: unknown;
  /** The write policy the hook would take for the operation */
  readonly decided: WritePolicy | undefined;
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
            decided: decidedWritePolicyFor('User', 'create'),
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

const configAwaiting = (atomic: boolean): RecipeConfig => ({
  modelOfAccessor: new Map([['user', 'User']]),
  relatedModel: () => undefined,
  decideWritePolicy: vi.fn(() => ({ sampled: true as const, atomic })),
});

/** Without `write.implicitTransaction`: no write policy is decided at the client boundary */
const configDecidingNothing: RecipeConfig = {
  modelOfAccessor: new Map([['user', 'User']]),
  relatedModel: () => undefined,
};

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
  it('runs a write whose audit is awaited in a transaction of its own, opened on the client it was made on, even inside a transaction of the caller', async () => {
    const clients = createClients();
    const callerTransaction = activeTransactionOf({ _caller: true });

    await withScope({ binding: { transaction: callerTransaction } }, async () => {
      await createUserOn(configAwaiting(true), clients, { email: 'a' });
    });

    expect(clients.openTransaction).toHaveBeenCalledTimes(1);
    expect(clients.openTransaction.mock.calls[0]?.[0]).toBe(clients.target);
    expect(clients.ran).toEqual([
      { client: 'transaction', bound: true, transactionClient: clients.tx, decided: { sampled: true, atomic: true } },
    ]);
  });

  it('binds an operation of a client outside any transaction to no transaction, whatever transaction it is awaited in', async () => {
    const clients = createClients();
    const callerTransaction = activeTransactionOf({ _caller: true });

    await withScope({ binding: { transaction: callerTransaction } }, async () => {
      await createUserOn(configDecidingNothing, clients, { email: 'a' });
    });

    expect(clients.openTransaction).not.toHaveBeenCalled();
    expect(clients.ran).toEqual([{ client: 'client', bound: true, transactionClient: undefined, decided: undefined }]);
  });

  describe('the client a $transaction callback receives', () => {
    it('binds its operations to the transaction, and opens none for a write whose audit is awaited', async () => {
      const clients = createClients();
      const transaction = activeTransactionOf(clients.tx);
      const bound = createRecipeClient(configAwaiting(true), clients.openTransaction).boundClient(transaction);

      await (bound.user as UserDelegate).create({ email: 'a' });

      expect(clients.openTransaction).not.toHaveBeenCalled();
      expect(clients.ran).toEqual([
        { client: 'transaction', bound: true, transactionClient: clients.tx, decided: { sampled: true, atomic: true } },
      ]);
    });

    it("returns every other property as the transaction's client holds it", () => {
      const clients = createClients();
      const marker = { marker: true };
      const transaction = activeTransactionOf({ ...clients.tx, $other: marker });
      const bound = createRecipeClient(configDecidingNothing, clients.openTransaction).boundClient(transaction);

      expect(bound.$other).toBe(marker);
      expect(bound.user).toBe(bound.user);
    });
  });

  it('decides the write policy of its call once and carries it to the hook', async () => {
    const clients = createClients();
    const config = configAwaiting(false);

    await createUserOn(config, clients, { email: 'a' });

    expect(config.decideWritePolicy).toHaveBeenCalledTimes(1);
    expect(config.decideWritePolicy).toHaveBeenCalledWith('User', 'create', { email: 'a' });
    expect(clients.ran).toEqual([
      { client: 'client', bound: true, transactionClient: undefined, decided: { sampled: true, atomic: false } },
    ]);
  });

  it('runs a write on the client itself while the audit processes an operation', async () => {
    const clients = createClients();

    await withScope({ isProcessingAuditLog: true }, async () => {
      await createUserOn(configAwaiting(true), clients, { email: 'a' });
    });

    expect(clients.openTransaction).not.toHaveBeenCalled();
    expect(clients.ran).toEqual([{ client: 'client', bound: true, transactionClient: undefined, decided: undefined }]);
  });

  it('runs once when awaited twice, both awaits receiving the one result', async () => {
    const clients = createClients();
    const created = createUserOn(configAwaiting(false), clients, { email: 'a' });

    const first = await created;
    const second = await created;

    expect(clients.ran).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('replays a fluent relation call on the operation it follows, under the decision made for that operation', async () => {
    const calls: unknown[] = [];
    const target = {
      user: {
        update: (args: unknown) => {
          calls.push(['update', args]);
          return {
            ...lazyOperation(() => ({ id: 'u1' })),
            posts: (postArgs: unknown) => {
              calls.push(['posts', postArgs]);
              return lazyOperation(() => ({ posts: postArgs, decided: decidedWritePolicyFor('User', 'update') }));
            },
          };
        },
      },
    };
    const config: RecipeConfig = {
      ...configAwaiting(false),
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
    expect(posts).toEqual({ posts: { take: 1 }, decided: { sampled: true, atomic: false } });
  });

  it('rejects when awaited after a batch has taken it, without running it', async () => {
    const clients = createClients();
    const created = createUserOn(configAwaiting(true), clients, { email: 'a' });

    takeBatchRecipes([created], clients.receiver, configAwaiting(true));

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
        () => createUserOn(configAwaiting(false), createClients(), { email: 'b' }),
        'was created by another client than the one $transaction is called on',
      ],
    ])('rejects %s, taking none of the operations', async (_label, makeItem, problem) => {
      const clients = createClients();
      const config = configAwaiting(false);
      const own = createUserOn(config, clients, { email: 'a' });

      expect(() => takeBatchRecipes([own, makeItem()], clients.receiver, config)).toThrow(
        `The operation at index 1 of the batch $transaction ${problem}`,
      );
      await own;
      expect(clients.ran).toHaveLength(1);
    });

    it('rejects an operation that has already run', async () => {
      const clients = createClients();
      const config = configAwaiting(false);
      const created = createUserOn(config, clients, { email: 'a' });
      await created;

      expect(() => takeBatchRecipes([created], clients.receiver, config)).toThrow(
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
    const rawMethodOf = (clients: ReturnType<typeof rawClient>, name: string, config = configAwaiting(true)) =>
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

    it('is a recipe no fluent relation follows and no write policy is decided for', async () => {
      const clients = rawClient();
      const config = configAwaiting(true);
      const command = rawMethodOf(clients, '$runCommandRaw', config)?.({ ping: 1 }) as PromiseLike<unknown> & object;

      expect('posts' in command).toBe(false);
      await expect(command).resolves.toEqual({ command: [{ ping: 1 }] });
      expect(config.decideWritePolicy).not.toHaveBeenCalled();
    });

    it('can be taken by a batch like the operation of a model, and runs on the client the batch gives', async () => {
      const clients = rawClient();
      const config = configAwaiting(true);
      const recipe = rawMethodOf(clients, '$queryRaw', config)?.('SELECT 2');
      const other = { $queryRaw: vi.fn((...args: unknown[]) => lazyOperation(() => ({ other: args }))) };

      const batch = takeBatchRecipes([recipe], clients.receiver, config);

      expect(batch.holdsModelWrite).toBe(false);
      await expect(Promise.all(batch.operationsOn(other))).resolves.toEqual([{ other: ['SELECT 2'] }]);
      expect(clients.target.$queryRaw).not.toHaveBeenCalled();
    });

    it('is not wrapped when the client behind it has no such method, nor are other client methods', () => {
      const clients = rawClient();
      const recipeClient = createRecipeClient(configAwaiting(true), clients.openTransaction);

      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$executeRaw')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$connect')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, Symbol.iterator)).toBeUndefined();
    });
  });

  describe('the operations a batch takes', () => {
    /** Deciding by action: creates await their audit, updates do not, deletes and reads are not audited */
    const decidingConfig = (): RecipeConfig => ({
      modelOfAccessor: new Map([['user', 'User']]),
      relatedModel: () => undefined,
      decideWritePolicy: (_model, action) => {
        if (action === 'create') {
          return { sampled: true, atomic: true };
        }
        return action === 'update' ? { sampled: true, atomic: false } : undefined;
      },
    });
    interface Seen {
      readonly action: string;
      readonly bound: boolean;
      readonly transactionClient: unknown;
      readonly decided: WritePolicy | undefined;
    }
    const userClient = (seen: Seen[]) => {
      const action = (name: string) => () =>
        lazyOperation(() => {
          const binding = currentScope()?.binding;
          seen.push({
            action: name,
            bound: binding !== undefined,
            transactionClient: binding?.transaction?.client,
            decided: decidedWritePolicyFor('User', name),
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

      expect(takeBatchRecipes(items, receiver, config).holdsModelWrite).toBe(true);
    });

    it('hold no write when each of them is a read', () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['findMany', 'count']);

      expect(takeBatchRecipes(items, receiver, config).holdsModelWrite).toBe(false);
    });

    it('hold no write for an empty batch', () => {
      expect(takeBatchRecipes([], {}, decidingConfig()).holdsModelWrite).toBe(false);
    });

    it("start on the client given for Prisma's own batch, each without a binding or a decision", async () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['findMany', 'count']);
      const seen: Seen[] = [];

      const operations = takeBatchRecipes(items, receiver, config).operationsOn(userClient(seen));
      await withScope({ binding: { transaction: activeTransactionOf({ _caller: true }) } }, () =>
        Promise.all(operations as PromiseLike<unknown>[]),
      );

      expect(seen).toEqual([
        { action: 'findMany', bound: false, transactionClient: undefined, decided: undefined },
        { action: 'count', bound: false, transactionClient: undefined, decided: undefined },
      ]);
    });

    it("run one after another on the transaction's client, each bound to it and under the decision made for its own call", async () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['create', 'update', 'delete']);
      const seen: Seen[] = [];
      const txClient = userClient(seen);

      const results = await takeBatchRecipes(items, receiver, config).runIn(activeTransactionOf(txClient));

      expect(results).toEqual(['create', 'update', 'delete']);
      expect(seen).toEqual([
        { action: 'create', bound: true, transactionClient: txClient, decided: { sampled: true, atomic: true } },
        { action: 'update', bound: true, transactionClient: txClient, decided: { sampled: true, atomic: false } },
        { action: 'delete', bound: true, transactionClient: txClient, decided: undefined },
      ]);
    });
  });

  it('answers in and Symbol.toStringTag as a promise of its own kind, with its fluent relations', () => {
    const clients = createClients();
    const config: RecipeConfig = {
      ...configAwaiting(true),
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
