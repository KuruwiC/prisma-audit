/**
 * Tests for operation recipes: when a recipe runs, on which client and in which transaction, and
 * how a batch takes it.
 */

import type { WritePolicy } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionalPrismaClient } from '../../src/internal-types.js';
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
    withScope({ transaction: { client: tx as TransactionalPrismaClient, deferredWrites: [] } }, () => callback(tx)),
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
    const callerTransaction = { _caller: true } as TransactionalPrismaClient;

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

  it('rejects when awaited after a batch has taken it, without running it', async () => {
    const clients = createClients();
    const created = createUserOn(configAwaiting(true), clients, { email: 'a' });

    takeBatchRecipes([created], clients.receiver, configAwaiting(true));

    await expect(Promise.resolve(created)).rejects.toThrow('given to a batch $transaction');
    expect(clients.ran).toEqual([]);
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
