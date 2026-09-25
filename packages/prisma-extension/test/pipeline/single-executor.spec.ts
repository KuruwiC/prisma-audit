/**
 * Tests for the single-operation executor: the before state and the nested records it reads
 * before the write, the mutation it runs through the operation's continuation, the events it
 * collects, and the error each kind of failure surfaces as.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { FailureSink } from '../../src/failure-sink.js';
import type { DMMFField, PrismaClientWithDynamicAccess, PrismaNamespace } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { AuditedOperation } from '../../src/pipeline/executor.js';
import type { RecordProducer } from '../../src/pipeline/produce-records.js';
import { createSingleExecutor } from '../../src/pipeline/single-executor.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';

type Row = Record<string, unknown>;

const scalar = (name: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'scalar',
  type: 'String',
  isList: false,
  ...extra,
});

const relation = (name: string, type: string, relationName: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'object',
  type,
  isList: false,
  relationName,
  relationFromFields: [],
  relationToFields: [],
  ...extra,
});

const Prisma: PrismaNamespace = {
  defineExtension: () => undefined,
  DbNull: null,
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'User',
          fields: [
            scalar('id', { isId: true }),
            scalar('name'),
            relation('profile', 'Profile', 'UserProfile'),
            relation('posts', 'Post', 'UserPosts', { isList: true }),
          ],
        },
        {
          name: 'Post',
          fields: [
            scalar('id', { isId: true }),
            scalar('title'),
            scalar('authorId'),
            relation('author', 'User', 'UserPosts', { relationFromFields: ['authorId'], relationToFields: ['id'] }),
          ],
        },
        {
          name: 'Profile',
          fields: [
            scalar('id', { isId: true }),
            scalar('userId', { isUnique: true }),
            scalar('bio'),
            relation('user', 'User', 'UserProfile', { relationFromFields: ['userId'], relationToFields: ['id'] }),
          ],
        },
      ],
    },
  },
};

const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };
const user: Row = { id: 'u1', name: 'Ann' };

const clientWith = (delegates: Record<string, Record<string, unknown>>): PrismaClientWithDynamicAccess => ({
  $transaction: async () => {
    throw new Error('no transaction is opened by the executor');
  },
  $extends: () => undefined,
  ...delegates,
});

const scopeOn = (client: PrismaClientWithDynamicAccess): ExecutionScope => ({
  auditContext,
  handle: client,
  baseHandle: client,
  atomic: true,
});

const createFailureSink = (): FailureSink => ({
  notify: vi.fn(async () => {}),
  reportWriteFailure: vi.fn(async () => {}),
});

/** The continuation the pipeline would build for `client`: the action of its `user` delegate */
const mutationOn = (client: PrismaClientWithDynamicAccess, action: string): ((args: Row) => Promise<unknown>) => {
  const mutation = (client.user as Record<string, unknown> | undefined)?.[action];
  if (typeof mutation !== 'function') {
    throw new Error(`Model "User" or action "${action}" not found`);
  }
  return mutation as (args: Row) => Promise<unknown>;
};

const operationOn = (
  client: PrismaClientWithDynamicAccess,
  action: AuditedOperation['action'],
  args: Row,
): AuditedOperation => ({
  model: 'User',
  action,
  args,
  execute: vi.fn(async (runArgs: Row, runAction: AuditedOperation['action'] = action) =>
    mutationOn(client, runAction)(runArgs),
  ),
});

const updateArgs = { where: { id: 'u1' }, data: { name: 'Anne' } };

interface ExecutorOptions {
  fetchBeforeOperation?: boolean;
  failureSink?: FailureSink;
}

const executorWith = (options: ExecutorOptions = {}) => {
  const getNestedOperationConfig = vi.fn(() => ({ fetchBeforeOperation: options.fetchBeforeOperation ?? true }));
  const failureSink = options.failureSink ?? createFailureSink();
  const executor = createSingleExecutor({ Prisma, schemaMetadata, getNestedOperationConfig, failureSink });
  const produceRecords = vi.fn<RecordProducer>(async () => []);
  return { executor, produceRecords, getNestedOperationConfig, failureSink };
};

const topLevelEvent = (fields: Row) => [
  expect.objectContaining({ model: 'User', origin: { path: '', op: expect.any(String) }, ...fields }),
];

describe('createSingleExecutor', () => {
  describe('before state', () => {
    it('requests no before state for a create and consults no nested-operation config', async () => {
      const findUnique = vi.fn();
      const client = clientWith({ user: { findUnique, create: vi.fn(async () => user) } });
      const { executor, produceRecords, getNestedOperationConfig } = executorWith();

      await executor.run(operationOn(client, 'create', { data: { name: 'Ann' } }), scopeOn(client), produceRecords);

      expect(findUnique).not.toHaveBeenCalled();
      expect(getNestedOperationConfig).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(
        topLevelEvent({ identity: 'u1', action: 'create', before: undefined, after: user }),
        expect.anything(),
      );
    });

    it.each([
      { action: 'update' as const, args: updateArgs, returns: { id: 'u1', name: 'Anne' } },
      { action: 'delete' as const, args: { where: { id: 'u1' } }, returns: user },
    ])('fetches the before state of $action when fetchBeforeOperation is on', async ({ action, args, returns }) => {
      const findUnique = vi.fn(async () => user);
      const client = clientWith({ user: { findUnique, [action]: vi.fn(async () => returns) } });
      const { executor, produceRecords, getNestedOperationConfig } = executorWith({ fetchBeforeOperation: true });

      await executor.run(operationOn(client, action, args), scopeOn(client), produceRecords);

      expect(getNestedOperationConfig).toHaveBeenCalledWith('User', action);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(produceRecords).toHaveBeenCalledWith(
        topLevelEvent({ identity: 'u1', action, before: user }),
        expect.anything(),
      );
    });

    it.each([
      { action: 'update' as const, args: updateArgs },
      { action: 'delete' as const, args: { where: { id: 'u1' } } },
    ])('skips the before state of $action when fetchBeforeOperation is off', async ({ action, args }) => {
      const findUnique = vi.fn();
      const client = clientWith({ user: { findUnique, [action]: vi.fn(async () => user) } });
      const { executor, produceRecords } = executorWith({ fetchBeforeOperation: false });

      await executor.run(operationOn(client, action, args), scopeOn(client), produceRecords);

      expect(findUnique).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(topLevelEvent({ action, before: undefined }), expect.anything());
    });

    it('always fetches the before state of an upsert and records an update when the row existed', async () => {
      const findUnique = vi.fn(async () => user);
      const client = clientWith({ user: { findUnique, upsert: vi.fn(async () => ({ id: 'u1', name: 'Anne' })) } });
      const { executor, produceRecords, getNestedOperationConfig } = executorWith({ fetchBeforeOperation: false });
      const args = { where: { id: 'u1' }, create: { name: 'Ann' }, update: { name: 'Anne' } };

      await executor.run(operationOn(client, 'upsert', args), scopeOn(client), produceRecords);

      expect(getNestedOperationConfig).not.toHaveBeenCalled();
      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(produceRecords).toHaveBeenCalledWith(
        topLevelEvent({ action: 'update', before: user, after: { id: 'u1', name: 'Anne' } }),
        expect.anything(),
      );
    });

    it('records a create for an upsert whose row did not exist', async () => {
      const client = clientWith({ user: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => user) } });
      const { executor, produceRecords } = executorWith();

      await executor.run(
        operationOn(client, 'upsert', { where: { id: 'u1' }, create: { name: 'Ann' }, update: {} }),
        scopeOn(client),
        produceRecords,
      );

      expect(produceRecords).toHaveBeenCalledWith(
        topLevelEvent({ action: 'create', before: undefined, after: user }),
        expect.anything(),
      );
    });

    it('reports a failed fetch under pre-fetch, runs the operation anyway and records it without a before state', async () => {
      const fetchError = new Error('connection reset');
      const update = vi.fn(async () => ({ id: 'u1', name: 'Anne' }));
      const client = clientWith({
        user: {
          findUnique: vi.fn(async () => {
            throw fetchError;
          }),
          update,
        },
      });
      const { executor, produceRecords, failureSink } = executorWith();
      const operation = operationOn(client, 'update', updateArgs);

      const outcome = await executor.run(operation, scopeOn(client), produceRecords);

      expect(failureSink.notify).toHaveBeenCalledWith({
        phase: 'pre-fetch',
        modelName: 'User',
        operation: 'update',
        params: operation.args,
        error: fetchError,
      });
      expect(update).toHaveBeenCalledWith(updateArgs);
      expect(outcome.result).toEqual({ id: 'u1', name: 'Anne' });
      expect(produceRecords).toHaveBeenCalledWith(
        topLevelEvent({ action: 'update', before: undefined }),
        expect.anything(),
      );
    });

    it('collects nothing for an upsert whose before-state fetch failed', async () => {
      const client = clientWith({
        user: {
          findUnique: vi.fn(async () => {
            throw new Error('connection reset');
          }),
          upsert: vi.fn(async () => user),
        },
      });
      const { executor, produceRecords, failureSink } = executorWith();

      await executor.run(
        operationOn(client, 'upsert', { where: { id: 'u1' }, create: { name: 'Ann' }, update: {} }),
        scopeOn(client),
        produceRecords,
      );

      expect(failureSink.notify).toHaveBeenCalledWith(expect.objectContaining({ phase: 'pre-fetch' }));
      expect(produceRecords).toHaveBeenCalledWith([], expect.anything());
    });
  });

  describe('nested records', () => {
    const profileBefore: Row = { id: 'pr1', userId: 'u1', bio: 'old' };
    const profileAfter: Row = { id: 'pr1', userId: 'u1', bio: 'new' };
    const nestedUpdateArgs = { where: { id: 'u1' }, data: { profile: { update: { bio: 'new' } } } };

    it('pre-fetches the nested record on the scope handle before the operation runs and pairs it with the written row', async () => {
      const calls: string[] = [];
      const client = clientWith({
        user: {
          findUnique: vi.fn(async () => user),
          update: vi.fn(async () => {
            calls.push('update');
            return { ...user, profile: profileAfter };
          }),
        },
        profile: {
          findUnique: vi.fn(async () => profileBefore),
          findFirst: vi.fn(async () => {
            calls.push('pre-fetch');
            return profileBefore;
          }),
        },
      });
      const { executor, produceRecords } = executorWith({ fetchBeforeOperation: true });

      await executor.run(operationOn(client, 'update', nestedUpdateArgs), scopeOn(client), produceRecords);

      expect(calls).toEqual(['pre-fetch', 'update']);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({ model: 'User', identity: 'u1', action: 'update' }),
          expect.objectContaining({
            model: 'Profile',
            identity: 'pr1',
            action: 'update',
            before: profileBefore,
            after: profileAfter,
            origin: { path: 'profile', op: 'update' },
          }),
        ],
        expect.anything(),
      );
    });

    it('reports a failed nested pre-fetch under pre-fetch and runs the operation anyway', async () => {
      const preFetchError = new Error('profile unavailable');
      const update = vi.fn(async () => ({ ...user, profile: profileAfter }));
      const client = clientWith({
        user: { findUnique: vi.fn(async () => user), update },
        profile: {
          findUnique: vi.fn(),
          findFirst: vi.fn(async () => {
            throw preFetchError;
          }),
        },
      });
      const { executor, produceRecords, failureSink } = executorWith({ fetchBeforeOperation: true });

      await executor.run(operationOn(client, 'update', nestedUpdateArgs), scopeOn(client), produceRecords);

      expect(failureSink.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'pre-fetch',
          modelName: 'Profile',
          operation: 'update',
          error: preFetchError,
        }),
      );
      expect(update).toHaveBeenCalledWith(nestedUpdateArgs);
    });
  });

  describe('rows a to-many relation holds before a nested create', () => {
    const existingPost: Row = { id: 'p1', title: 'A', authorId: 'u1' };
    const createdPost: Row = { id: 'p2', title: 'B', authorId: 'u1' };

    it('snapshots them on the scope handle before the operation and audits only the created row', async () => {
      const calls: string[] = [];
      const findMany = vi.fn(async () => {
        calls.push('snapshot');
        return [{ id: 'p1' }];
      });
      const client = clientWith({
        user: {
          findUnique: vi.fn(async () => user),
          update: vi.fn(async () => {
            calls.push('update');
            return { ...user, posts: [existingPost, createdPost] };
          }),
        },
        post: { findMany },
      });
      const { executor, produceRecords } = executorWith();

      await executor.run(
        operationOn(client, 'update', { where: { id: 'u1' }, data: { posts: { create: { title: 'B' } } } }),
        scopeOn(client),
        produceRecords,
      );

      expect(calls).toEqual(['snapshot', 'update']);
      expect(findMany).toHaveBeenCalledWith({ where: { author: { is: { id: 'u1' } } }, select: { id: true } });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({ model: 'User', action: 'update' }),
          expect.objectContaining({
            model: 'Post',
            identity: 'p2',
            action: 'create',
            origin: { path: 'posts', op: 'create' },
          }),
        ],
        expect.anything(),
      );
    });

    it('snapshots nothing under a row the operation creates', async () => {
      const findMany = vi.fn();
      const client = clientWith({
        user: { create: vi.fn(async () => ({ ...user, posts: [createdPost] })) },
        post: { findMany },
      });
      const { executor, produceRecords } = executorWith();

      await executor.run(
        operationOn(client, 'create', { data: { name: 'Ann', posts: { create: { title: 'B' } } } }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({ model: 'User' }),
          expect.objectContaining({ model: 'Post', identity: 'p2', action: 'create' }),
        ],
        expect.anything(),
      );
    });
  });

  describe('rows a nested batch filter matches', () => {
    const p1Before: Row = { id: 'p1', title: 'A', authorId: 'u1' };
    const p1After: Row = { id: 'p1', title: 'X', authorId: 'u1' };
    const sibling: Row = { id: 'p2', title: 'B', authorId: 'u1' };
    const underU1 = (filter: Row) => ({ ...filter, AND: [{ author: { is: { id: 'u1' } } }] });
    const updateManyArgs = {
      where: { id: 'u1' },
      data: { posts: { updateMany: { where: { title: 'A' }, data: { title: 'X' } } } },
    };

    it('reads them on the scope handle before the operation and audits those rows only, with their before state', async () => {
      const calls: string[] = [];
      const findMany = vi.fn(async () => {
        calls.push('pre-read');
        return [p1Before];
      });
      const client = clientWith({
        user: {
          findUnique: vi.fn(async () => user),
          update: vi.fn(async () => {
            calls.push('update');
            return { ...user, posts: [p1After, sibling] };
          }),
        },
        post: { findMany },
      });
      const { executor, produceRecords } = executorWith();

      await executor.run(operationOn(client, 'update', updateManyArgs), scopeOn(client), produceRecords);

      expect(calls).toEqual(['pre-read', 'update']);
      expect(findMany).toHaveBeenCalledWith({ where: underU1({ title: 'A' }) });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({ model: 'User', action: 'update' }),
          {
            model: 'Post',
            identity: 'p1',
            action: 'update',
            before: p1Before,
            after: p1After,
            origin: { path: 'posts', op: 'updateMany' },
          },
        ],
        expect.anything(),
      );
    });

    it('reads their primary keys only when the before state of an update is not requested', async () => {
      const findMany = vi.fn(async () => [{ id: 'p1' }]);
      const client = clientWith({
        user: { findUnique: vi.fn(), update: vi.fn(async () => ({ ...user, posts: [p1After, sibling] })) },
        post: { findMany },
      });
      const { executor, produceRecords } = executorWith({ fetchBeforeOperation: false });

      await executor.run(operationOn(client, 'update', updateManyArgs), scopeOn(client), produceRecords);

      expect(findMany).toHaveBeenCalledWith({ where: underU1({ title: 'A' }), select: { id: true } });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({ model: 'User', action: 'update' }),
          expect.objectContaining({
            model: 'Post',
            identity: 'p1',
            action: 'update',
            before: undefined,
            after: p1After,
            origin: { path: 'posts', op: 'updateMany' },
          }),
        ],
        expect.anything(),
      );
    });

    it('collects a delete per row a deleteMany matched, from the pre-read', async () => {
      const findMany = vi.fn(async () => [p1Before]);
      const client = clientWith({
        user: { findUnique: vi.fn(async () => user), update: vi.fn(async () => user) },
        post: { findMany },
      });
      const { executor, produceRecords } = executorWith();

      await executor.run(
        operationOn(client, 'update', { where: { id: 'u1' }, data: { posts: { deleteMany: { title: 'A' } } } }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany).toHaveBeenCalledWith({ where: underU1({ title: 'A' }) });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({ model: 'User', action: 'update' }),
          expect.objectContaining({
            model: 'Post',
            identity: 'p1',
            action: 'delete',
            before: p1Before,
            origin: { path: 'posts', op: 'deleteMany' },
          }),
        ],
        expect.anything(),
      );
    });
  });

  describe('execution', () => {
    it("runs the operation's continuation with the operation args", async () => {
      const create = vi.fn(async () => user);
      const client = clientWith({ user: { create } });
      const { executor, produceRecords } = executorWith();
      const operation = operationOn(client, 'create', { data: { name: 'Ann' } });

      const outcome = await executor.run(operation, scopeOn(client), produceRecords);

      expect(operation.execute).toHaveBeenCalledWith(operation.args);
      expect(create).toHaveBeenCalledWith(operation.args);
      expect(outcome.result).toBe(user);
    });

    it("propagates the operation's own failure as it is and produces no records", async () => {
      const callerError = new Error('Unique constraint failed on the fields: (`name`)');
      const client = clientWith({
        user: {
          create: vi.fn(async () => {
            throw callerError;
          }),
        },
      });
      const { executor, produceRecords } = executorWith();

      const run = executor.run(
        operationOn(client, 'create', { data: { name: 'Ann' } }),
        scopeOn(client),
        produceRecords,
      );

      await expect(run).rejects.toBe(callerError);
      expect(produceRecords).not.toHaveBeenCalled();
    });
  });
});
