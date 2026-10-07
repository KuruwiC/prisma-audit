/**
 * Tests for operation recipes: when a recipe runs, on which client and in which transaction, and
 * how a batch takes it.
 */

import type { WritePolicy } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import { createRecipeClient, type RecipeConfig, takeBatchRecipes } from '../../src/runtime/operation-recipe.js';
import { currentScope, decidedWritePolicyFor, withScope } from '../../src/runtime/scope.js';

/** A lazy operation, as Prisma's operations are: it runs, once, when it is awaited */
const lazyOperation = (run: () => unknown) => {
  let started: Promise<unknown> | undefined;
  return {
    [Symbol.toStringTag]: 'PrismaPromise',
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
      started ??= Promise.resolve().then(run);
      return started.then(onFulfilled, onRejected);
    },
  };
};

interface Ran {
  readonly client: string;
  readonly transactionClient: unknown;
  /** The write policy the hook would take for the operation */
  readonly decided: WritePolicy | undefined;
}

/**
 * An audited client (`receiver`) and the client behind it (`target`), whose `user.create` records
 * the client it ran on and the transaction client the runtime scope held then. The receiver's
 * `$transaction` runs its callback on `tx` inside the scope of that transaction, as the client
 * proxy's does.
 */
const createClients = () => {
  const ran: Ran[] = [];
  const clientNamed = (name: string) => ({
    user: {
      create: (args: unknown) =>
        lazyOperation(() => {
          ran.push({
            client: name,
            transactionClient: currentScope()?.transaction?.client,
            decided: decidedWritePolicyFor('User', 'create'),
          });
          return { created: args };
        }),
    },
  });
  const tx = clientNamed('transaction');
  const $transaction = vi.fn(async (callback: (client: object) => Promise<unknown>) =>
    withScope({ transaction: { client: tx, deferredWrites: [] } }, () => callback(tx)),
  );
  const receiver = { $transaction };
  const target = clientNamed('client');
  return { receiver, target, tx, ran, $transaction };
};

const configAwaiting = (atomic: boolean): RecipeConfig => ({
  modelOfAccessor: new Map([['user', 'User']]),
  relatedModel: () => undefined,
  decideWritePolicy: vi.fn(() => ({ sampled: true as const, atomic })),
});

/** `receiver.user.create(args)` as the client proxy returns it */
const createUserOn = (config: RecipeConfig, clients: ReturnType<typeof createClients>, args: unknown) => {
  const delegate = createRecipeClient(config).propertyOf(clients.receiver, clients.target, 'user')?.value as {
    create: (args: unknown) => PromiseLike<unknown>;
  };
  return delegate.create(args);
};

describe('operation recipes', () => {
  it('runs a write whose audit is awaited in a transaction of its own, even inside a transaction of the caller', async () => {
    const clients = createClients();
    const callerTransaction: PrismaHandle = { _caller: true };

    await withScope({ transaction: { client: callerTransaction, deferredWrites: [] } }, async () => {
      await createUserOn(configAwaiting(true), clients, { email: 'a' });
    });

    expect(clients.$transaction).toHaveBeenCalledTimes(1);
    expect(clients.ran).toEqual([
      { client: 'transaction', transactionClient: clients.tx, decided: { sampled: true, atomic: true } },
    ]);
  });

  it('decides the write policy of its call once and carries it to the hook', async () => {
    const clients = createClients();
    const config = configAwaiting(false);

    await createUserOn(config, clients, { email: 'a' });

    expect(config.decideWritePolicy).toHaveBeenCalledTimes(1);
    expect(config.decideWritePolicy).toHaveBeenCalledWith('User', 'create');
    expect(clients.ran).toEqual([
      { client: 'client', transactionClient: undefined, decided: { sampled: true, atomic: false } },
    ]);
  });

  it('runs a write on the client itself while the audit processes an operation', async () => {
    const clients = createClients();

    await withScope({ isProcessingAuditLog: true }, async () => {
      await createUserOn(configAwaiting(true), clients, { email: 'a' });
    });

    expect(clients.$transaction).not.toHaveBeenCalled();
    expect(clients.ran).toEqual([{ client: 'client', transactionClient: undefined, decided: undefined }]);
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
    const delegate = createRecipeClient(config).propertyOf({ $transaction: vi.fn() }, target, 'user')?.value as {
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
      return { receiver: { $transaction: vi.fn() }, target: { $queryRaw: queryRaw, $runCommandRaw: runCommandRaw } };
    };
    const rawMethodOf = (clients: ReturnType<typeof rawClient>, name: string, config = configAwaiting(true)) =>
      createRecipeClient(config).propertyOf(clients.receiver, clients.target, name)?.value as
        | ((...args: unknown[]) => PromiseLike<unknown> & object)
        | undefined;

    it('returns a recipe that calls the method on the client behind it, with the arguments, when awaited', async () => {
      const clients = rawClient();

      const recipe = rawMethodOf(clients, '$queryRaw')?.(['SELECT 1'], 7);

      expect(clients.target.$queryRaw).not.toHaveBeenCalled();
      await expect(recipe).resolves.toEqual({ rows: [['SELECT 1'], 7] });
      expect(clients.target.$queryRaw).toHaveBeenCalledTimes(1);
      expect(clients.receiver.$transaction).not.toHaveBeenCalled();
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

      expect(batch.awaitsAudit).toBe(false);
      await expect(Promise.all(batch.operationsOn(other))).resolves.toEqual([{ other: ['SELECT 2'] }]);
      expect(clients.target.$queryRaw).not.toHaveBeenCalled();
    });

    it('is not wrapped when the client behind it has no such method, nor are other client methods', () => {
      const clients = rawClient();
      const recipeClient = createRecipeClient(configAwaiting(true));

      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$executeRaw')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, '$connect')).toBeUndefined();
      expect(recipeClient.propertyOf(clients.receiver, clients.target, Symbol.iterator)).toBeUndefined();
    });
  });

  describe('the operations a batch takes', () => {
    /** Deciding by action: creates await their audit, updates do not, deletes are not audited */
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
    const userClient = (seen: Array<{ action: string; decided: WritePolicy | undefined }>) => {
      const action = (name: string) => () =>
        lazyOperation(() => {
          seen.push({ action: name, decided: decidedWritePolicyFor('User', name) });
          return name;
        });
      return { user: { create: action('create'), update: action('update'), delete: action('delete') } };
    };
    const recipesOn = (receiver: object, target: object, config: RecipeConfig, actions: string[]) => {
      const user = createRecipeClient(config).propertyOf(receiver, target, 'user')?.value as Record<
        string,
        () => PromiseLike<unknown>
      >;
      return actions.map((name) => user[name]?.() as PromiseLike<unknown>);
    };

    it('await an audit when one of them is an audited write whose audit is awaited', () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['update', 'delete', 'create']);

      expect(takeBatchRecipes(items, receiver, config).awaitsAudit).toBe(true);
    });

    it('do not await an audit when each is unaudited or its audit is not awaited', () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['update', 'delete']);

      expect(takeBatchRecipes(items, receiver, config).awaitsAudit).toBe(false);
    });

    it('do not await an audit for an empty batch', () => {
      expect(takeBatchRecipes([], {}, decidingConfig()).awaitsAudit).toBe(false);
    });

    it('start on the client given, each in the scope of the decision made for its own call', async () => {
      const receiver = {};
      const config = decidingConfig();
      const items = recipesOn(receiver, userClient([]), config, ['create', 'update', 'delete']);
      const seen: Array<{ action: string; decided: WritePolicy | undefined }> = [];

      const operations = takeBatchRecipes(items, receiver, config).operationsOn(userClient(seen));
      await expect(Promise.all(operations as PromiseLike<unknown>[])).resolves.toEqual(['create', 'update', 'delete']);

      expect(seen).toEqual([
        { action: 'create', decided: { sampled: true, atomic: true } },
        { action: 'update', decided: { sampled: true, atomic: false } },
        { action: 'delete', decided: undefined },
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
