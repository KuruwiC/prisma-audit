/**
 * Tests for the single-operation executor: the before state and the nested records it reads
 * before the write, the mutation it runs on the scope's handle, the events it collects, the
 * re-read that hydrates the result, and the error each kind of failure surfaces as.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { FailureSink } from '../../src/failure-sink.js';
import type { DMMFField, PrismaClientWithDynamicAccess, PrismaNamespace } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { AuditedOperation } from '../../src/pipeline/executor.js';
import type { RecordProducer } from '../../src/pipeline/produce-records.js';
import { createSingleExecutor, wrapAuditFailure } from '../../src/pipeline/single-executor.js';
import { isCallerMutationError } from '../../src/utils/caller-mutation-error.js';
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
          fields: [scalar('id', { isId: true }), scalar('name'), relation('profile', 'Profile', 'UserProfile')],
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

const operationOf = (action: AuditedOperation['action'], args: Row): AuditedOperation => ({
  model: 'User',
  action,
  args,
  query: vi.fn(),
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

      await executor.run(operationOf('create', { data: { name: 'Ann' } }), scopeOn(client), produceRecords);

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

      await executor.run(operationOf(action, args), scopeOn(client), produceRecords);

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

      await executor.run(operationOf(action, args), scopeOn(client), produceRecords);

      expect(findUnique).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(topLevelEvent({ action, before: undefined }), expect.anything());
    });

    it('always fetches the before state of an upsert and records an update when the row existed', async () => {
      const findUnique = vi.fn(async () => user);
      const client = clientWith({ user: { findUnique, upsert: vi.fn(async () => ({ id: 'u1', name: 'Anne' })) } });
      const { executor, produceRecords, getNestedOperationConfig } = executorWith({ fetchBeforeOperation: false });
      const args = { where: { id: 'u1' }, create: { name: 'Ann' }, update: { name: 'Anne' } };

      await executor.run(operationOf('upsert', args), scopeOn(client), produceRecords);

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
        operationOf('upsert', { where: { id: 'u1' }, create: { name: 'Ann' }, update: {} }),
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
      const operation = operationOf('update', updateArgs);

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
        operationOf('upsert', { where: { id: 'u1' }, create: { name: 'Ann' }, update: {} }),
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

      await executor.run(operationOf('update', nestedUpdateArgs), scopeOn(client), produceRecords);

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

      await executor.run(operationOf('update', nestedUpdateArgs), scopeOn(client), produceRecords);

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

  describe('execution', () => {
    it('runs the action of the model delegate on the scope handle with the operation args', async () => {
      const create = vi.fn(async () => user);
      const client = clientWith({ user: { create } });
      const { executor, produceRecords } = executorWith();
      const operation = operationOf('create', { data: { name: 'Ann' } });

      const outcome = await executor.run(operation, scopeOn(client), produceRecords);

      expect(create).toHaveBeenCalledWith(operation.args);
      expect(operation.query).not.toHaveBeenCalled();
      expect(outcome.result).toBe(user);
    });

    it('re-reads the written row so the caller receives its hydrated fields', async () => {
      const hydrated = { id: 'u1', name: 'Ann', createdAt: new Date('2025-01-01T00:00:00Z') };
      const findUnique = vi.fn(async () => hydrated);
      const client = clientWith({ user: { create: vi.fn(async () => user) }, User: { findUnique } });
      const { executor, produceRecords } = executorWith();

      const outcome = await executor.run(
        operationOf('create', { data: { name: 'Ann' } }),
        scopeOn(client),
        produceRecords,
      );

      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(outcome.result).toBe(hydrated);
    });

    it("tags the caller's own mutation error so the pipeline rethrows it raw", async () => {
      const callerError = new Error('Unique constraint failed on the fields: (`name`)');
      const client = clientWith({
        user: {
          create: vi.fn(async () => {
            throw callerError;
          }),
        },
      });
      const { executor, produceRecords } = executorWith();

      const run = executor.run(operationOf('create', { data: { name: 'Ann' } }), scopeOn(client), produceRecords);

      await expect(run).rejects.toBe(callerError);
      expect(isCallerMutationError(callerError)).toBe(true);
      expect(produceRecords).not.toHaveBeenCalled();
    });

    it('fails when the model delegate has no such action', async () => {
      const client = clientWith({ user: {} });
      const { executor, produceRecords } = executorWith();

      await expect(executor.run(operationOf('update', updateArgs), scopeOn(client), produceRecords)).rejects.toThrow(
        'Model "User" or action "update" not found',
      );
    });
  });

  describe('audit failure', () => {
    it('wraps an audit failure with the model and action and keeps the original error as cause', () => {
      const original = new Error('diff calculation failed');

      const surfaced = wrapAuditFailure(operationOf('update', updateArgs), original);

      expect(surfaced.message).toBe(
        '[@prisma-audit] Audited operation failed for model "User" and action "update": diff calculation failed',
      );
      expect(surfaced.cause).toBe(original);
      expect(executorWith().executor.auditFailure).toBe(wrapAuditFailure);
    });
  });
});
