/**
 * Tests for the batch-operation executor: the rows it reads before an update or a delete, the
 * ids it injects into a createMany, the mutation it runs on the scope's handle, the pairing of
 * written rows with their before rows, and each action's return-value contract.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { DMMFField, PrismaClientWithDynamicAccess, PrismaNamespace } from '../../src/internal-types.js';
import { createBatchExecutor } from '../../src/pipeline/batch-executor.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { AuditedOperation } from '../../src/pipeline/executor.js';
import type { RecordProducer } from '../../src/pipeline/produce-records.js';
import { NO_CLIENT_OMITTED_FIELDS } from '../../src/utils/client-omit.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';
import { runWithRecords } from './run-with-records.js';

type Row = Record<string, unknown>;

const scalar = (name: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'scalar',
  type: 'String',
  isList: false,
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
            scalar('id', { isId: true, hasDefaultValue: true, default: { name: 'cuid', args: [] } }),
            scalar('email'),
            scalar('nickname', { hasDefaultValue: true, default: 'anonymous' }),
            scalar('updatedAt', { type: 'DateTime', isUpdatedAt: true }),
          ],
        },
      ],
    },
  },
};

const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

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
  baseClient: client,
  atomic: true,
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

const executor = createBatchExecutor({ Prisma, schemaMetadata, clientOmittedFields: NO_CLIENT_OMITTED_FIELDS });
const produce = () => vi.fn<RecordProducer>(async () => []);
const eventOf = (fields: Row) => expect.objectContaining({ model: 'User', ...fields });
const findManyReturning = (...results: Row[][]) => {
  const findMany = vi.fn<(args: Row) => Promise<Row[]>>();
  for (const rows of results) {
    findMany.mockResolvedValueOnce(rows);
  }
  return findMany;
};

const a1: Row = { id: 'a', email: 'a@1' };
const a2: Row = { id: 'a', email: 'a@2' };
const b1: Row = { id: 'b', email: 'b@1' };
const b2: Row = { id: 'b', email: 'b@2' };

describe('createBatchExecutor', () => {
  describe('createMany', () => {
    it('inserts the rows with client-generated ids, audits them and returns the count', async () => {
      const createMany = vi.fn<(args: { data: Row[] }) => Promise<{ count: number }>>(async () => ({ count: 2 }));
      const client = clientWith({ user: { createMany } });
      const produceRecords = produce();
      const args = { data: [{ email: 'a@1' }, { email: 'b@1' }] };

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'createMany', args),
        scopeOn(client),
        produceRecords,
      );

      const inserted = createMany.mock.calls[0]?.[0].data ?? [];
      expect(inserted).toEqual([
        { email: 'a@1', id: expect.any(String) },
        { email: 'b@1', id: expect.any(String) },
      ]);
      expect(outcome.result).toEqual({ count: 2 });
      expect(produceRecords).toHaveBeenCalledWith(
        inserted.map((row) =>
          eventOf({
            identity: row.id,
            action: 'create',
            before: { kind: 'none' },
            after: row,
            origin: { path: '', op: 'createMany' },
          }),
        ),
        expect.anything(),
      );
    });

    it('audits an optional column the data leaves out as null, and leaves out the columns the database fills', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const client = clientWith({ user: { createMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'createMany', { data: [{}] }),
        scopeOn(client),
        produceRecords,
      );

      expect(createMany).toHaveBeenCalledWith({ data: [{ id: expect.any(String) }] });
      expect(produceRecords).toHaveBeenCalledWith(
        [eventOf({ action: 'create', after: { id: expect.any(String), email: null } })],
        expect.anything(),
      );
    });

    it('normalizes a single data object to one row', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const client = clientWith({ user: { createMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'createMany', { data: { email: 'a@1' } }),
        scopeOn(client),
        produceRecords,
      );

      expect(createMany).toHaveBeenCalledWith({ data: [{ email: 'a@1', id: expect.any(String) }] });
      expect(produceRecords).toHaveBeenCalledWith([eventOf({ action: 'create' })], expect.anything());
    });

    it('audits the rows createManyAndReturn returned when no select or omit narrows them', async () => {
      const createManyAndReturn = vi.fn(async () => [a1, b1]);
      const client = clientWith({ user: { createManyAndReturn } });
      const produceRecords = produce();
      const args = { data: [{ email: 'a@1' }, { email: 'b@1' }], skipDuplicates: true };

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'createManyAndReturn', args),
        scopeOn(client),
        produceRecords,
      );

      expect(createManyAndReturn).toHaveBeenCalledWith(args);
      expect(outcome.result).toEqual([a1, b1]);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({ identity: 'a', action: 'create', after: a1 }),
          eventOf({ identity: 'b', action: 'create', after: b1 }),
        ],
        expect.anything(),
      );
    });

    it('audits the rows a createManyAndReturn with a select returns, without injecting ids', async () => {
      const createManyAndReturn = vi.fn(async () => [a1]);
      const client = clientWith({ user: { createManyAndReturn } });
      const produceRecords = produce();
      const args = { data: [{ email: 'a@1' }], select: { email: true, id: true } };

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'createManyAndReturn', args),
        scopeOn(client),
        produceRecords,
      );

      expect(createManyAndReturn).toHaveBeenCalledWith(args);
      expect(outcome.result).toEqual([a1]);
      expect(produceRecords).toHaveBeenCalledWith(
        [eventOf({ identity: 'a', action: 'create', after: a1 })],
        expect.anything(),
      );
    });
  });

  describe('updateMany', () => {
    it('reads the matching rows before, re-reads them by primary key after and pairs each after row with its before row', async () => {
      const findMany = findManyReturning([a1, b1], [b2, a2]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const client = clientWith({ user: { findMany, updateMany } });
      const produceRecords = produce();
      const args = { where: { email: { contains: '@' } }, data: { email: 'x' } };

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'updateMany', args),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany.mock.calls).toEqual([[{ where: args.where }], [{ where: { id: { in: ['a', 'b'] } } }]]);
      expect(updateMany).toHaveBeenCalledWith(args);
      expect(outcome.result).toEqual({ count: 2 });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({
            identity: 'b',
            action: 'update',
            before: { kind: 'captured', row: b1 },
            after: b2,
            origin: { path: '', op: 'updateMany' },
          }),
          eventOf({
            identity: 'a',
            action: 'update',
            before: { kind: 'captured', row: a1 },
            after: a2,
            origin: { path: '', op: 'updateMany' },
          }),
        ],
        expect.anything(),
      );
    });

    it('audits nothing and does not re-read when no row matched', async () => {
      const findMany = vi.fn(async () => []);
      const client = clientWith({ user: { findMany, updateMany: vi.fn(async () => ({ count: 0 })) } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where: {}, data: {} }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(produceRecords).toHaveBeenCalledWith([], expect.anything());
    });

    it('reads without a where clause as an unfiltered findMany', async () => {
      const findMany = vi.fn(async () => []);
      const client = clientWith({ user: { findMany, updateMany: vi.fn(async () => ({ count: 0 })) } });

      await runWithRecords(executor, operationOn(client, 'updateMany', { data: {} }), scopeOn(client), produce());

      expect(findMany).toHaveBeenCalledWith({ where: {} });
    });

    it('audits exactly the rows updateManyAndReturn returns for a limited update and keeps the count contract', async () => {
      const findMany = vi.fn(async () => [a1, b1]);
      const updateMany = vi.fn();
      const updateManyAndReturn = vi.fn(async () => [b2]);
      const client = clientWith({ user: { findMany, updateMany, updateManyAndReturn } });
      const produceRecords = produce();
      const args = { where: {}, data: { email: 'x' }, limit: 1 };

      const operation = operationOn(client, 'updateMany', args);

      const outcome = await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany).toHaveBeenCalledWith({ where: {} });
      expect(operation.execute).toHaveBeenCalledWith(args, 'updateManyAndReturn');
      expect(updateManyAndReturn).toHaveBeenCalledWith(args);
      expect(updateMany).not.toHaveBeenCalled();
      expect(outcome.result).toEqual({ count: 1 });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({
            identity: 'b',
            action: 'update',
            before: { kind: 'captured', row: b1 },
            after: b2,
            origin: { path: '', op: 'updateMany' },
          }),
        ],
        expect.anything(),
      );
    });

    it('returns the rows for a limited updateManyAndReturn', async () => {
      const updateManyAndReturn = vi.fn(async () => [b2]);
      const client = clientWith({ user: { findMany: vi.fn(async () => [b1]), updateManyAndReturn } });

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'updateManyAndReturn', { where: {}, data: {}, limit: 1 }),
        scopeOn(client),
        produce(),
      );

      expect(outcome.result).toEqual([b2]);
    });

    it('limits the before read with take on a connector without updateManyAndReturn', async () => {
      const findMany = findManyReturning([a1], [a2]);
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const client = clientWith({ user: { findMany, updateMany } });
      const args = { where: {}, data: { email: 'x' }, limit: 1 };

      await runWithRecords(executor, operationOn(client, 'updateMany', args), scopeOn(client), produce());

      expect(findMany).toHaveBeenNthCalledWith(1, { where: {}, take: 1 });
      expect(updateMany).toHaveBeenCalledWith(args);
    });
  });

  describe('deleteMany', () => {
    it('audits the rows matched before the delete with their before state and no after state', async () => {
      const findMany = vi.fn(async () => [a1, b1]);
      const deleteMany = vi.fn(async () => ({ count: 2 }));
      const client = clientWith({ user: { findMany, deleteMany } });
      const produceRecords = produce();
      const args = { where: { email: { contains: '@' } } };

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'deleteMany', args),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(deleteMany).toHaveBeenCalledWith(args);
      expect(outcome.result).toEqual({ count: 2 });
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({
            identity: 'a',
            action: 'delete',
            before: { kind: 'captured', row: a1 },
            after: undefined,
            origin: { path: '', op: 'deleteMany' },
          }),
          eventOf({
            identity: 'b',
            action: 'delete',
            before: { kind: 'captured', row: b1 },
            after: undefined,
            origin: { path: '', op: 'deleteMany' },
          }),
        ],
        expect.anything(),
      );
    });

    it('propagates limit to the before read as take', async () => {
      const findMany = vi.fn(async () => [a1]);
      const client = clientWith({ user: { findMany, deleteMany: vi.fn(async () => ({ count: 1 })) } });

      await runWithRecords(
        executor,
        operationOn(client, 'deleteMany', { where: {}, limit: 1 }),
        scopeOn(client),
        produce(),
      );

      expect(findMany).toHaveBeenCalledWith({ where: {}, take: 1 });
    });
  });

  describe('failures', () => {
    it('fails an update or delete when the model delegate has no findMany', async () => {
      const client = clientWith({ user: { updateMany: vi.fn() } });

      await expect(
        runWithRecords(
          executor,
          operationOn(client, 'updateMany', { where: {}, data: {} }),
          scopeOn(client),
          produce(),
        ),
      ).rejects.toThrow('Model User does not have findMany operation');
    });

    it("propagates the operation's own failure as it is and produces no records", async () => {
      const callerError = new Error('Unique constraint failed on the fields: (`email`)');
      const client = clientWith({
        user: {
          createMany: vi.fn(async () => {
            throw callerError;
          }),
        },
      });
      const produceRecords = produce();

      await expect(
        runWithRecords(
          executor,
          operationOn(client, 'createMany', { data: [{ email: 'a@1' }] }),
          scopeOn(client),
          produceRecords,
        ),
      ).rejects.toBe(callerError);

      expect(produceRecords).not.toHaveBeenCalled();
    });
  });
});
