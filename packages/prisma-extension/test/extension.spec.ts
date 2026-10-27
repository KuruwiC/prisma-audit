/**
 * The audit gate of the extension's hook: which operations it audits, skips or rejects before
 * they run, on the arguments that reach it
 */

import {
  type AuditContext,
  AuditContextMissingError,
  type AuditRecord,
  createAsyncLocalStorageProvider,
  defineEntity,
} from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { createAuditLogExtension } from '../src/extension.js';
import type { ExtensionParams, PrismaBaseClient } from '../src/internal-types.js';
import { withScope } from '../src/runtime/scope.js';
import type { PrismaAuditExtensionOptions } from '../src/types.js';
import { auditSchema, column, model, relation } from './support/audit-schema.js';

const context: AuditContext = { actor: { category: 'model', type: 'User', id: 'actor-1' } };

const schema = auditSchema(
  model('User', [
    column('id', { isId: true, isRequired: true }),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
  ]),
  model('Post', [
    column('id', { isId: true, isRequired: true }),
    column('authorId'),
    relation('author', 'User', 'UserPosts', {
      isRequired: true,
      foreignKeyFields: ['authorId'],
      referencedFields: ['id'],
    }),
  ]),
);

interface AuditedClient {
  readonly $transaction: (first: unknown) => Promise<unknown>;
  readonly user: { readonly create: (args: unknown) => PromiseLike<unknown> };
}

type Options = Partial<Omit<PrismaAuditExtensionOptions, 'Prisma' | 'schema' | 'contextProvider'>>;

/**
 * A client the audit extension extends, as `createAuditClient` does: `user.create` runs through the
 * extension's hook, whose `query` returns `result`, and an interactive `$transaction` calls its
 * callback with the client. Audit rows go to `writer`.
 */
const auditedClient = (options: Options, result: unknown = { id: 'u1' }) => {
  const provider = createAsyncLocalStorageProvider();
  const query = vi.fn(async (_args: unknown) => result);
  const transaction = vi.fn();
  const writer = vi.fn(async (_records: AuditRecord[]) => {});
  const base: PrismaBaseClient = {
    $transaction: async () => {
      throw new Error('the audit opens no transaction on the base client');
    },
    $extends: (extension: unknown) => {
      const { $allOperations } = (
        extension as { query: { $allOperations: (params: ExtensionParams) => Promise<unknown> } }
      ).query;
      const client: AuditedClient = {
        $transaction: async (first) => {
          transaction();
          return (first as (tx: AuditedClient) => Promise<unknown>)(client);
        },
        user: { create: (args) => $allOperations({ model: 'User', operation: 'create', args, query }) },
      };
      return client;
    },
  };
  const extend = createAuditLogExtension({
    Prisma: { defineExtension: (definition: unknown) => definition, DbNull: null },
    schema,
    contextProvider: provider,
    entities: { User: defineEntity({ type: 'User' }), Post: defineEntity({ type: 'Post' }) },
    ...options,
    write: { writer, ...options.write },
  }) as (client: PrismaBaseClient) => AuditedClient;
  return { client: extend(base), provider, query, transaction, writer };
};

const nestedPostCreate = { data: { id: 'u1', posts: { create: { id: 'p1' } } } };

describe('the audit gate of the extension hook', () => {
  it('rejects a write without an audit context to a model that requires one, before it runs', async () => {
    const { client, query, writer } = auditedClient({ requireContext: true });

    const rejection = client.user.create({ data: { id: 'u1' } });

    await expect(rejection).rejects.toBeInstanceOf(AuditContextMissingError);
    await expect(rejection).rejects.toMatchObject({
      modelName: 'User',
      operationModelName: 'User',
      operation: 'create',
    });
    expect(query).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('rejects a write without an audit context whose nested write writes a model that requires one', async () => {
    const { client, query } = auditedClient({ requireContext: (modelName) => modelName === 'Post' });

    await expect(client.user.create(nestedPostCreate)).rejects.toMatchObject({
      name: 'AuditContextMissingError',
      modelName: 'Post',
      operationModelName: 'User',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a write the nested write of which requires a context when the operation model is not audited', async () => {
    const { client, query } = auditedClient({
      entities: { Post: defineEntity({ type: 'Post' }) },
      requireContext: true,
    });

    await expect(client.user.create(nestedPostCreate)).rejects.toMatchObject({ modelName: 'Post' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a write without an audit context at a samplingRate of 0', async () => {
    const { client, query } = auditedClient({ requireContext: true, samplingRate: 0 });

    await expect(client.user.create({ data: { id: 'u1' } })).rejects.toBeInstanceOf(AuditContextMissingError);
    expect(query).not.toHaveBeenCalled();
  });

  it('runs a write without an audit context unaudited by default', async () => {
    const { client, query, writer } = auditedClient({});

    await expect(client.user.create({ data: { id: 'u1' } })).resolves.toEqual({ id: 'u1' });
    expect(query).toHaveBeenCalledWith({ data: { id: 'u1' } });
    expect(writer).not.toHaveBeenCalled();
  });

  it('runs unaudited, without a context, a write of a model the requireContext function is false for', async () => {
    const { client, query, writer } = auditedClient({ requireContext: (modelName) => modelName === 'Post' });

    await expect(client.user.create({ data: { id: 'u1' } })).resolves.toEqual({ id: 'u1' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(writer).not.toHaveBeenCalled();
  });

  it('runs unaudited, without a context, a write of a model that is not audited, whatever requireContext says', async () => {
    const { client, query } = auditedClient({
      entities: { Post: defineEntity({ type: 'Post' }) },
      requireContext: true,
    });

    await expect(client.user.create({ data: { id: 'u1' } })).resolves.toEqual({ id: 'u1' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("runs unaudited a write issued while the audit processes an operation, such as one of a user callback's, without a context", async () => {
    const { client, query, writer } = auditedClient({ requireContext: true });

    await withScope({ isProcessingAuditLog: true }, async () => {
      await expect(client.user.create({ data: { id: 'u1' } })).resolves.toEqual({ id: 'u1' });
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(writer).not.toHaveBeenCalled();
  });

  it('audits, with a context, the audited rows a nested write of an operation on a model that is not audited writes', async () => {
    const { client, provider, writer } = auditedClient(
      { entities: { Post: defineEntity({ type: 'Post' }) } },
      { id: 'u1', posts: [{ id: 'p1', authorId: 'u1' }] },
    );

    await provider.runAsync(context, async () => {
      await client.user.create(nestedPostCreate);
    });

    const records = writer.mock.calls.flatMap(([written]) => written);
    expect(records.map(({ entityType, entityId, action }) => ({ entityType, entityId, action }))).toEqual([
      { entityType: 'Post', entityId: 'p1', action: 'create' },
    ]);
  });

  describe('with write.implicitTransaction', () => {
    const implicit = { write: { implicitTransaction: true } };

    it('opens no transaction for a write without an audit context, and rejects it when it requires one', async () => {
      const { client, query, transaction } = auditedClient({ ...implicit, requireContext: true });

      await expect(client.user.create({ data: { id: 'u1' } })).rejects.toBeInstanceOf(AuditContextMissingError);
      expect(transaction).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects, when it is awaited, a write made with an audit context that is awaited without one', async () => {
      const { client, provider, query, transaction } = auditedClient({ ...implicit, requireContext: true });

      const created = provider.run(context, () => client.user.create({ data: { id: 'u1' } }));

      await expect(created).rejects.toBeInstanceOf(AuditContextMissingError);
      expect(transaction).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it('opens a transaction, with a context, for a write on a model that is not audited whose nested write writes an audited one', async () => {
      const { client, provider, transaction, writer } = auditedClient(
        { ...implicit, entities: { Post: defineEntity({ type: 'Post' }) } },
        { id: 'u1', posts: [{ id: 'p1', authorId: 'u1' }] },
      );

      await provider.runAsync(context, async () => {
        await client.user.create(nestedPostCreate);
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(writer.mock.calls.flatMap(([written]) => written).map((record) => record.entityType)).toEqual(['Post']);
    });

    it('opens no transaction, with a context, for a write that writes no audited model', async () => {
      const { client, provider, query, transaction } = auditedClient({
        ...implicit,
        entities: { Post: defineEntity({ type: 'Post' }) },
      });

      await provider.runAsync(context, async () => {
        await client.user.create({ data: { id: 'u1' } });
      });

      expect(transaction).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});
