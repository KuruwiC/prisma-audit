/**
 * Tests for the batch-operation executor: the rows it reads before an update or a delete, the
 * ids it injects into a createMany and the rows it reads back after it, the mutation it runs on
 * the scope's handle, the pairing of written rows with their before rows, and each action's
 * return-value contract.
 */

import type { AuditContext, FailureSink } from '@kuruwic/db-audit-core';
import { Decimal } from '@prisma/client/runtime/library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DMMFField, PrismaClientWithDynamicAccess, PrismaNamespace } from '../../src/internal-types.js';
import { createBatchExecutor } from '../../src/pipeline/batch-executor.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { AuditedOperation } from '../../src/pipeline/executor.js';
import type { RecordProducer } from '../../src/pipeline/produce-records.js';
import { NO_AUDITED_OMITTED_FIELDS, withRowKeyFields } from '../../src/utils/audited-omitted-fields.js';
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
  Decimal,
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
        {
          name: 'Membership',
          fields: [
            scalar('orgId', { type: 'BigInt', isRequired: true }),
            scalar('userId', { type: 'BigInt', isRequired: true }),
            scalar('role'),
          ],
          primaryKey: { name: null, fields: ['orgId', 'userId'] },
        },
        {
          name: 'Device',
          fields: [
            scalar('label', { isUnique: true }),
            scalar('serial', { isUnique: true, isRequired: true, default: { name: 'cuid', args: [] } }),
            scalar('name'),
          ],
        },
        { name: 'Note', fields: [scalar('label', { isUnique: true }), scalar('text', { isRequired: true })] },
        { name: 'Reading', fields: [scalar('at', { type: 'DateTime', isId: true }), scalar('value')] },
        { name: 'Counter', fields: [scalar('id', { type: 'Int', isId: true }), scalar('value')] },
        {
          name: 'Slot',
          fields: [
            scalar('room', { isRequired: true }),
            scalar('at', { type: 'DateTime', isRequired: true }),
            scalar('note'),
          ],
          primaryKey: { name: null, fields: ['room', 'at'] },
        },
        { name: 'Rate', fields: [scalar('amount', { type: 'Decimal', isId: true }), scalar('label')] },
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
  inPrismaBatch: false,
  atomic: true,
});

/** The scope of an operation inside an interactive transaction whose client is `client` */
const transactionScopeOn = (client: PrismaClientWithDynamicAccess): ExecutionScope => ({
  ...scopeOn(client),
  transaction: { deferredWrites: [] },
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
  widened: new Map(),
  execute: vi.fn(async (runArgs: Row, runAction: AuditedOperation['action'] = action) =>
    mutationOn(client, runAction)(runArgs),
  ),
});

const createFailureSink = (): FailureSink => ({
  notify: vi.fn(async () => {}),
  reportResolverFailures: vi.fn(async () => {}),
  reportDroppedBuild: vi.fn(async () => {}),
  reportWriteFailure: vi.fn(async () => {}),
});

/** An executor on a client that takes a query omit (Prisma 6.2 and later) when `queryOmitSupported` */
const createExecutor = (failureSink: FailureSink, queryOmitSupported = false) =>
  createBatchExecutor({
    Prisma,
    schemaMetadata,
    auditedOmittedFieldsWithRowKey: withRowKeyFields(NO_AUDITED_OMITTED_FIELDS, schemaMetadata, queryOmitSupported),
    failureSink,
  });
const produce = () => vi.fn<RecordProducer>(async () => []);
const eventOf = (fields: Row) => expect.objectContaining({ model: 'User', ...fields });
const findManyReturning = (...results: Row[][]) => {
  const findMany = vi.fn<(args: Row) => Promise<Row[]>>();
  for (const rows of results) {
    findMany.mockResolvedValueOnce(rows);
  }
  return findMany;
};
const findManyByIds = (rowOf: (id: string) => Row) =>
  vi.fn<(args: { where: Row }) => Promise<Row[]>>(async ({ where }) =>
    (where.id as { in: string[] }).in.map((id) => rowOf(id)),
  );

/** A createMany on `model`, run on a client holding that model's `createMany` and `findMany` */
const createManyOn = (model: string, delegate: { createMany: unknown; findMany: unknown }, args: Row) => {
  const client = clientWith({ [model.charAt(0).toLowerCase() + model.slice(1)]: delegate });
  const createMany = delegate.createMany as (runArgs: Row) => Promise<unknown>;
  const operation: AuditedOperation = {
    model,
    action: 'createMany',
    args,
    widened: new Map(),
    execute: vi.fn(async (runArgs: Row) => createMany(runArgs)),
  };
  return { client, operation };
};

const unidentifiedMessage = (action: string, count: number) =>
  `${count} of the rows a limited ${action} wrote cannot be told apart from rows another writer changed`;

const NO_ROW_KEY_MESSAGE =
  '[@prisma-audit] Model "Note" has no primary key and no unique constraint on required fields: its rows cannot be identified for a batch audit.';

/** An operation on `model` (a model without a primary key), run on a client holding `delegate` for it */
const operationOnModel = (
  model: string,
  delegate: Record<string, unknown>,
  action: AuditedOperation['action'],
  args: Row,
) => {
  const client = clientWith({ [model.charAt(0).toLowerCase() + model.slice(1)]: delegate });
  const mutation = delegate[action] as (runArgs: Row) => Promise<unknown>;
  const operation: AuditedOperation = {
    model,
    action,
    args,
    widened: new Map(),
    execute: vi.fn(async (runArgs: Row) => mutation(runArgs)),
  };
  return { client, operation };
};

const a1: Row = { id: 'a', email: 'a@1' };
const a2: Row = { id: 'a', email: 'a@2' };
const b1: Row = { id: 'b', email: 'b@1' };
const b2: Row = { id: 'b', email: 'b@2' };

describe('createBatchExecutor', () => {
  let failureSink: FailureSink;
  let executor: ReturnType<typeof createExecutor>;

  beforeEach(() => {
    failureSink = createFailureSink();
    executor = createExecutor(failureSink);
  });

  describe('createMany', () => {
    it('inserts the rows with client-generated ids, reads them back by primary key, audits the rows read and returns the count', async () => {
      const createMany = vi.fn<(args: { data: Row[] }) => Promise<{ count: number }>>(async () => ({ count: 2 }));
      const findMany = findManyByIds((id) => ({ id, email: `${id}@read`, nickname: 'anonymous' }));
      const client = clientWith({ user: { createMany, findMany } });
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
      expect(findMany.mock.calls).toEqual([[{ where: { id: { in: inserted.map((row) => row.id) } } }]]);
      expect(outcome.result).toEqual({ count: 2 });
      expect(produceRecords).toHaveBeenCalledWith(
        inserted.map((row) =>
          eventOf({
            identity: row.id,
            action: 'create',
            before: { kind: 'none' },
            after: { id: row.id, email: `${row.id}@read`, nickname: 'anonymous' },
            origin: { path: '', op: 'createMany' },
          }),
        ),
        expect.anything(),
        new Map(),
      );
    });

    it('audits the rows read back once per primary key in data order, and none for a row the read does not find', async () => {
      const createMany = vi.fn(async () => ({ count: 2 }));
      const findMany = findManyReturning([
        { id: 'c', email: 'c@read' },
        { id: 'a', email: 'a@read' },
      ]);
      const client = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'createMany', {
          data: [
            { id: 'a', email: 'a@1' },
            { id: 'b', email: 'b@1' },
            { id: 'c', email: 'c@1' },
            { id: 'a', email: 'a@2' },
          ],
          skipDuplicates: true,
        }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany.mock.calls).toEqual([[{ where: { id: { in: ['a', 'b', 'c', 'a'] } } }]]);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({ identity: 'a', action: 'create', after: { id: 'a', email: 'a@read' } }),
          eventOf({ identity: 'c', action: 'create', after: { id: 'c', email: 'c@read' } }),
        ],
        expect.anything(),
        new Map(),
      );
    });

    it('audits every row the read returns: in data order where its key reads as data gave it, after those in read order where it does not', async () => {
      const createMany = vi.fn(async () => ({ count: 2 }));
      const findMany = findManyReturning([
        { id: 'x1', email: 'x1@read' },
        { id: 'b', email: 'b@read' },
      ]);
      const client = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'createMany', {
          data: [
            { id: 'X1', email: 'x1@1' },
            { id: 'b', email: 'b@1' },
          ],
        }),
        scopeOn(client),
        produceRecords,
      );

      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({ identity: 'b', action: 'create', after: { id: 'b', email: 'b@read' } }),
          eventOf({ identity: 'x1', action: 'create', after: { id: 'x1', email: 'x1@read' } }),
        ],
        expect.anything(),
        new Map(),
      );
      expect(failureSink.notify).not.toHaveBeenCalled();
    });

    it('audits the row of a composite BigInt key that data gives as numbers, under the key as read', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const findMany = findManyReturning([{ orgId: 1n, userId: 2n, role: 'member' }]);
      const { client, operation } = createManyOn(
        'Membership',
        { createMany, findMany },
        {
          data: [{ orgId: 1, userId: 2, role: 'member' }],
        },
      );
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where: { OR: [{ orgId: 1, userId: 2 }] } }]]);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            model: 'Membership',
            identity: '["1","2"]',
            action: 'create',
            after: { orgId: 1n, userId: 2n, role: 'member' },
          }),
        ],
        expect.anything(),
        new Map(),
      );
    });

    it('reads the primary-key fields whatever a client-level omit hides, on a client that takes a query omit', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const findMany = findManyReturning([{ id: 'a', email: 'a@read' }]);
      const client = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      await runWithRecords(
        createExecutor(failureSink, true),
        operationOn(client, 'createMany', { data: [{ id: 'a', email: 'a@1' }] }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany.mock.calls).toEqual([[{ where: { id: { in: ['a'] } }, omit: { id: false } }]]);
      expect(produceRecords).toHaveBeenCalledWith(
        [eventOf({ identity: 'a', action: 'create', after: { id: 'a', email: 'a@read' } })],
        expect.anything(),
        new Map(),
      );
    });

    it('reports the created rows the read does not find as row-identification, and audits the rows it finds', async () => {
      const createMany = vi.fn(async () => ({ count: 3 }));
      const findMany = findManyReturning([a1, b1]);
      const client = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'createMany', { data: [a1, b1, { id: 'c', email: 'c@1' }] }),
        scopeOn(client),
        produceRecords,
      );

      expect(outcome.result).toEqual({ count: 3 });
      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith({
        phase: 'row-identification',
        modelName: 'User',
        operation: 'createMany',
        params: { unidentified: 1 },
        error: new Error('1 of the rows a createMany created was not found when read back by key'),
      });
      expect(produceRecords).toHaveBeenCalledWith(
        [eventOf({ identity: 'a', after: a1 }), eventOf({ identity: 'b', after: b1 })],
        expect.anything(),
        new Map(),
      );
    });

    it('audits a row once when the reads of two chunks of keys both return it', async () => {
      const ids = [...Array.from({ length: 1000 }, (_, index) => `r${index}`), 'R0'];
      const createMany = vi.fn(async () => ({ count: 1000 }));
      const findMany = vi.fn(async ({ where }: { where: Row }) =>
        Array.from(new Set((where.id as { in: string[] }).in.map((id) => id.toLowerCase())), (id) => ({ id })),
      );
      const client = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'createMany', { data: ids.map((id) => ({ id })), skipDuplicates: true }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany).toHaveBeenCalledTimes(2);
      expect(produceRecords.mock.calls[0]?.[0].map((event) => event.identity)).toEqual(ids.slice(0, 1000));
      expect(failureSink.notify).not.toHaveBeenCalled();
    });

    it('reads back the rows of a model without a primary key by its first unique field on required columns, generating it when data leaves it out', async () => {
      const createMany = vi.fn<(args: { data: Row[] }) => Promise<{ count: number }>>(async () => ({ count: 1 }));
      const findMany = vi.fn(async ({ where }: { where: Row }) =>
        (where.serial as { in: string[] }).in.map((serial) => ({ label: null, serial, name: 'd1' })),
      );
      const { client, operation } = createManyOn('Device', { createMany, findMany }, { data: [{ name: 'd1' }] });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      const serial = createMany.mock.calls[0]?.[0].data[0]?.serial;
      expect(createMany).toHaveBeenCalledWith({
        data: [{ name: 'd1', serial: expect.stringMatching(/^c[a-z0-9]{24}$/) }],
      });
      expect(findMany.mock.calls).toEqual([[{ where: { serial: { in: [serial] } } }]]);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            model: 'Device',
            identity: serial,
            action: 'create',
            after: { label: null, serial, name: 'd1' },
          }),
        ],
        expect.anything(),
        new Map(),
      );
    });

    it('fails before the write for a model with no primary key and no unique constraint on required columns, naming the model', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const findMany = vi.fn(async () => []);
      const { client, operation } = createManyOn('Note', { createMany, findMany }, { data: [{ text: 't' }] });

      await expect(runWithRecords(executor, operation, scopeOn(client), produce())).rejects.toThrow(NO_ROW_KEY_MESSAGE);
      expect(createMany).not.toHaveBeenCalled();
    });

    it('reads the created rows on the handle of the interactive transaction it runs in', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const findMany = findManyReturning([{ id: 'a', email: 'a@read' }]);
      const transactionClient = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(transactionClient, 'createMany', { data: [{ id: 'a', email: 'a@1' }] }),
        { ...transactionScopeOn(transactionClient), baseClient: clientWith({ user: {} }) },
        produceRecords,
      );

      expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ['a'] } } });
      expect(produceRecords).toHaveBeenCalledWith(
        [eventOf({ identity: 'a', action: 'create', after: { id: 'a', email: 'a@read' } })],
        expect.anything(),
        new Map(),
      );
    });

    it('normalizes a single data object to one row', async () => {
      const createMany = vi.fn(async () => ({ count: 1 }));
      const findMany = findManyByIds((id) => ({ id, email: 'a@1' }));
      const client = clientWith({ user: { createMany, findMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'createMany', { data: { email: 'a@1' } }),
        scopeOn(client),
        produceRecords,
      );

      expect(createMany).toHaveBeenCalledWith({ data: [{ email: 'a@1', id: expect.any(String) }] });
      expect(produceRecords).toHaveBeenCalledWith([eventOf({ action: 'create' })], expect.anything(), new Map());
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
        new Map(),
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
        new Map(),
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
      expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
    });

    it('reads without a where clause as an unfiltered findMany', async () => {
      const findMany = vi.fn(async () => []);
      const client = clientWith({ user: { findMany, updateMany: vi.fn(async () => ({ count: 0 })) } });

      await runWithRecords(executor, operationOn(client, 'updateMany', { data: {} }), scopeOn(client), produce());

      expect(findMany).toHaveBeenCalledWith({ where: {} });
    });

    describe('with a limit', () => {
      const where = { email: { contains: '@' } };
      const data = { email: 'x' };
      const narrowedTo = (ids: string[]) => ({ AND: [where, { id: { in: ids } }] });
      const updateEvent = (before: Row, after: Row) =>
        eventOf({
          identity: before.id,
          action: 'update',
          before: { kind: 'captured', row: before },
          after,
          origin: { path: '', op: 'updateMany' },
        });

      it('reads the primary keys the limit selects, continues the update without the limit narrowed to them, and audits those rows', async () => {
        const findMany = findManyReturning([a1, b1], [a2, b2]);
        const updateMany = vi.fn(async () => ({ count: 2 }));
        const client = clientWith({ user: { findMany, updateMany } });
        const produceRecords = produce();
        const operation = operationOn(client, 'updateMany', { where, data, limit: 2 });

        const outcome = await runWithRecords(executor, operation, scopeOn(client), produceRecords);

        expect(findMany.mock.calls).toEqual([[{ where, take: 2 }], [{ where: { id: { in: ['a', 'b'] } } }]]);
        expect(operation.execute).toHaveBeenCalledTimes(1);
        expect(operation.execute).toHaveBeenCalledWith({ where: narrowedTo(['a', 'b']), data });
        expect(outcome.result).toEqual({ count: 2 });
        expect(produceRecords).toHaveBeenCalledWith(
          [updateEvent(a1, a2), updateEvent(b1, b2)],
          expect.anything(),
          new Map(),
        );
      });

      it('tops up, inside an interactive transaction, a round that updated fewer rows than it read with rows read the same way, leaving out the rows already read', async () => {
        const c1: Row = { id: 'c', email: 'c@1' };
        const c2: Row = { id: 'c', email: 'c@2' };
        const findMany = findManyReturning([a1, b1], [c1], [a1], [a2, c2]);
        const updateMany = vi.fn<() => Promise<{ count: number }>>();
        updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
        const client = clientWith({ user: { findMany, updateMany } });
        const produceRecords = produce();
        const operation = operationOn(client, 'updateMany', { where, data, limit: 2 });

        const outcome = await runWithRecords(executor, operation, transactionScopeOn(client), produceRecords);

        expect(findMany.mock.calls).toEqual([
          [{ where, take: 2 }],
          [{ where: { AND: [where, { NOT: { id: { in: ['a', 'b'] } } }] }, take: 1 }],
          [{ where: narrowedTo(['a', 'b']) }],
          [{ where: { id: { in: ['a', 'c'] } } }],
        ]);
        expect(vi.mocked(operation.execute).mock.calls).toEqual([
          [{ where: narrowedTo(['a', 'b']), data }],
          [{ where: narrowedTo(['c']), data }],
        ]);
        expect(outcome.result).toEqual({ count: 2 });
        expect(produceRecords).toHaveBeenCalledWith(
          [updateEvent(a1, a2), updateEvent(c1, c2)],
          expect.anything(),
          new Map(),
        );
      });

      it('writes one round outside any transaction, and reports the rows of a short round it cannot tell apart as row-identification', async () => {
        const findMany = findManyReturning([a1, b1], []);
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const client = clientWith({ user: { findMany, updateMany } });
        const produceRecords = produce();

        const outcome = await runWithRecords(
          executor,
          operationOn(client, 'updateMany', { where, data, limit: 2 }),
          scopeOn(client),
          produceRecords,
        );

        expect(outcome.result).toEqual({ count: 1 });
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls).toEqual([[{ where, take: 2 }], [{ where: narrowedTo(['a', 'b']) }]]);
        expect(failureSink.notify).toHaveBeenCalledTimes(1);
        expect(failureSink.notify).toHaveBeenCalledWith({
          phase: 'row-identification',
          modelName: 'User',
          operation: 'updateMany',
          params: { unidentified: 1 },
          error: new Error(unidentifiedMessage('updateMany', 1)),
        });
        expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
      });

      it('writes nothing and counts zero when the first read selects no row, even inside an interactive transaction', async () => {
        const findMany = findManyReturning([]);
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const client = clientWith({ user: { findMany, updateMany } });
        const produceRecords = produce();

        const outcome = await runWithRecords(
          executor,
          operationOn(client, 'updateMany', { where, data, limit: 2 }),
          transactionScopeOn(client),
          produceRecords,
        );

        expect(outcome.result).toEqual({ count: 0 });
        expect(findMany.mock.calls).toEqual([[{ where, take: 2 }]]);
        expect(updateMany).not.toHaveBeenCalled();
        expect(failureSink.notify).not.toHaveBeenCalled();
        expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
      });

      it('stops after three rounds inside an interactive transaction', async () => {
        const findMany = findManyReturning([a1], [b1], [{ id: 'c', email: 'c@1' }]);
        const updateMany = vi.fn(async () => ({ count: 0 }));
        const client = clientWith({ user: { findMany, updateMany } });

        const outcome = await runWithRecords(
          executor,
          operationOn(client, 'updateMany', { where, data, limit: 1 }),
          transactionScopeOn(client),
          produce(),
        );

        expect(outcome.result).toEqual({ count: 0 });
        expect(updateMany).toHaveBeenCalledTimes(3);
        expect(findMany).toHaveBeenCalledTimes(3);
      });

      it.each([
        { scope: 'inside a batch Prisma runs', limit: 2, inPrismaBatch: true, reported: { unidentified: 2 } },
        { scope: 'with a limit that is not a positive integer', limit: 0, inPrismaBatch: false, reported: undefined },
      ])('runs the update as given $scope and audits none of its rows', async ({ limit, inPrismaBatch, reported }) => {
        const findMany = vi.fn(async () => []);
        const updateMany = vi.fn(async () => ({ count: 2 }));
        const client = clientWith({ user: { findMany, updateMany } });
        const produceRecords = produce();
        const args = { where, data, limit };

        const outcome = await runWithRecords(
          executor,
          operationOn(client, 'updateMany', args),
          { ...scopeOn(client), inPrismaBatch },
          produceRecords,
        );

        expect(updateMany).toHaveBeenCalledWith(args);
        expect(findMany).not.toHaveBeenCalled();
        expect(outcome.result).toEqual({ count: 2 });
        expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
        if (reported) {
          expect(failureSink.notify).toHaveBeenCalledTimes(1);
          expect(failureSink.notify).toHaveBeenCalledWith({
            phase: 'row-identification',
            modelName: 'User',
            operation: 'updateMany',
            params: reported,
            error: new Error(unidentifiedMessage('updateMany', reported.unidentified)),
          });
        } else {
          expect(failureSink.notify).not.toHaveBeenCalled();
        }
      });
    });

    it('audits an updateManyAndReturn from the rows it returns, paired by primary key with the rows read before, without reading them again', async () => {
      const findMany = findManyReturning([a1, b1]);
      const updateManyAndReturn = vi.fn(async () => [b2, a2]);
      const client = clientWith({ user: { findMany, updateManyAndReturn } });
      const produceRecords = produce();
      const args = { where: { email: { contains: '@' } }, data: { email: 'x' } };

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'updateManyAndReturn', args),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany.mock.calls).toEqual([[{ where: args.where }]]);
      expect(updateManyAndReturn).toHaveBeenCalledWith(args);
      expect(outcome.result).toEqual([b2, a2]);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({
            identity: 'b',
            action: 'update',
            before: { kind: 'captured', row: b1 },
            after: b2,
            origin: { path: '', op: 'updateManyAndReturn' },
          }),
          eventOf({
            identity: 'a',
            action: 'update',
            before: { kind: 'captured', row: a1 },
            after: a2,
            origin: { path: '', op: 'updateManyAndReturn' },
          }),
        ],
        expect.anything(),
        new Map(),
      );
    });

    it('runs an updateManyAndReturn with a limit as given, reading the rows once without the limit, and pairs the returned rows with them', async () => {
      const findMany = findManyReturning([b1]);
      const updateManyAndReturn = vi.fn(async () => [b2]);
      const client = clientWith({ user: { findMany, updateManyAndReturn } });
      const produceRecords = produce();
      const args = { where: {}, data: { email: 'x' }, limit: 1 };
      const operation = operationOn(client, 'updateManyAndReturn', args);

      const outcome = await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where: {} }]]);
      expect(operation.execute).toHaveBeenCalledTimes(1);
      expect(operation.execute).toHaveBeenCalledWith(args);
      expect(outcome.result).toEqual([b2]);
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({
            identity: 'b',
            action: 'update',
            before: { kind: 'captured', row: b1 },
            after: b2,
            origin: { path: '', op: 'updateManyAndReturn' },
          }),
        ],
        expect.anything(),
        new Map(),
      );
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
        new Map(),
      );
    });

    describe('with a limit', () => {
      const where = { email: { contains: '@' } };
      const narrowedTo = (ids: string[]) => ({ AND: [where, { id: { in: ids } }] });
      const deleteEvent = (before: Row) =>
        eventOf({
          identity: before.id,
          action: 'delete',
          before: { kind: 'captured', row: before },
          origin: { path: '', op: 'deleteMany' },
        });

      it('reads the primary keys the limit selects, continues the delete without the limit narrowed to them, and audits those rows as read', async () => {
        const findMany = findManyReturning([a1, b1]);
        const deleteMany = vi.fn(async () => ({ count: 2 }));
        const client = clientWith({ user: { findMany, deleteMany } });
        const produceRecords = produce();
        const operation = operationOn(client, 'deleteMany', { where, limit: 2 });

        const outcome = await runWithRecords(executor, operation, scopeOn(client), produceRecords);

        expect(findMany.mock.calls).toEqual([[{ where, take: 2 }]]);
        expect(operation.execute).toHaveBeenCalledWith({ where: narrowedTo(['a', 'b']) });
        expect(outcome.result).toEqual({ count: 2 });
        expect(produceRecords).toHaveBeenCalledWith([deleteEvent(a1), deleteEvent(b1)], expect.anything(), new Map());
      });

      it('tops up, inside an interactive transaction, a round that deleted fewer rows than it read, auditing the read rows that are gone when as many are gone as it deleted', async () => {
        const c1: Row = { id: 'c', email: 'c@1' };
        const findMany = findManyReturning([a1, b1], [c1], [b1]);
        const deleteMany = vi.fn<() => Promise<{ count: number }>>();
        deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
        const client = clientWith({ user: { findMany, deleteMany } });
        const produceRecords = produce();
        const operation = operationOn(client, 'deleteMany', { where, limit: 2 });

        const outcome = await runWithRecords(executor, operation, transactionScopeOn(client), produceRecords);

        expect(findMany.mock.calls).toEqual([
          [{ where, take: 2 }],
          [{ where: { AND: [where, { NOT: { id: { in: ['a', 'b'] } } }] }, take: 1 }],
          [{ where: { id: { in: ['a', 'b'] } } }],
        ]);
        expect(vi.mocked(operation.execute).mock.calls).toEqual([
          [{ where: narrowedTo(['a', 'b']) }],
          [{ where: narrowedTo(['c']) }],
        ]);
        expect(outcome.result).toEqual({ count: 2 });
        expect(produceRecords).toHaveBeenCalledWith([deleteEvent(a1), deleteEvent(c1)], expect.anything(), new Map());
      });

      it('reports the rows of a short round it cannot tell apart as row-identification, and audits none of them', async () => {
        const findMany = findManyReturning([a1, b1], [], []);
        const deleteMany = vi.fn(async () => ({ count: 1 }));
        const client = clientWith({ user: { findMany, deleteMany } });
        const produceRecords = produce();

        const outcome = await runWithRecords(
          executor,
          operationOn(client, 'deleteMany', { where, limit: 2 }),
          scopeOn(client),
          produceRecords,
        );

        expect(outcome.result).toEqual({ count: 1 });
        expect(failureSink.notify).toHaveBeenCalledTimes(1);
        expect(failureSink.notify).toHaveBeenCalledWith({
          phase: 'row-identification',
          modelName: 'User',
          operation: 'deleteMany',
          params: { unidentified: 1 },
          error: new Error(unidentifiedMessage('deleteMany', 1)),
        });
        expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
      });
    });
  });

  describe('a model without a primary key, identified by a unique field on a required column', () => {
    const d1: Row = { label: null, serial: 's1', name: 'one' };
    const d2: Row = { label: null, serial: 's2', name: 'two' };
    const renamed = (row: Row): Row => ({ ...row, name: 'renamed' });
    const where = { name: { not: 'x' } };
    const data = { name: 'renamed' };
    const bySerials = (...serials: string[]) => ({ serial: { in: serials } });
    const updateEvent = (before: Row, after: Row, op: string) =>
      expect.objectContaining({
        model: 'Device',
        action: 'update',
        before: { kind: 'captured', row: before },
        after,
        origin: { path: '', op },
      });
    const deleteEvent = (before: Row) =>
      expect.objectContaining({
        model: 'Device',
        action: 'delete',
        before: { kind: 'captured', row: before },
        origin: { path: '', op: 'deleteMany' },
      });

    it('reads the matching rows before, re-reads them by the unique field after and pairs each after row with its before row on an updateMany', async () => {
      const findMany = findManyReturning([d1, d2], [renamed(d2), renamed(d1)]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const { client, operation } = operationOnModel('Device', { findMany, updateMany }, 'updateMany', { where, data });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where }], [{ where: bySerials('s1', 's2') }]]);
      expect(produceRecords).toHaveBeenCalledWith(
        [updateEvent(d2, renamed(d2), 'updateMany'), updateEvent(d1, renamed(d1), 'updateMany')],
        expect.anything(),
        new Map(),
      );
    });

    it('pairs the rows an updateManyAndReturn returns with the rows read before, by the unique field', async () => {
      const findMany = findManyReturning([d1, d2]);
      const updateManyAndReturn = vi.fn(async () => [renamed(d2), renamed(d1)]);
      const { client, operation } = operationOnModel(
        'Device',
        { findMany, updateManyAndReturn },
        'updateManyAndReturn',
        {
          where,
          data,
        },
      );
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where }]]);
      expect(produceRecords).toHaveBeenCalledWith(
        [updateEvent(d2, renamed(d2), 'updateManyAndReturn'), updateEvent(d1, renamed(d1), 'updateManyAndReturn')],
        expect.anything(),
        new Map(),
      );
    });

    it('narrows an updateMany with a limit to the unique values of the rows its limit selected, and audits those rows', async () => {
      const findMany = findManyReturning([d1, d2], [renamed(d1), renamed(d2)]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const { client, operation } = operationOnModel('Device', { findMany, updateMany }, 'updateMany', {
        where,
        data,
        limit: 2,
      });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where, take: 2 }], [{ where: bySerials('s1', 's2') }]]);
      expect(operation.execute).toHaveBeenCalledWith({ where: { AND: [where, bySerials('s1', 's2')] }, data });
      expect(produceRecords).toHaveBeenCalledWith(
        [updateEvent(d1, renamed(d1), 'updateMany'), updateEvent(d2, renamed(d2), 'updateMany')],
        expect.anything(),
        new Map(),
      );
    });

    it('narrows a deleteMany with a limit to the unique values of the rows its limit selected, and audits those rows as read', async () => {
      const findMany = findManyReturning([d1, d2]);
      const deleteMany = vi.fn(async () => ({ count: 2 }));
      const { client, operation } = operationOnModel('Device', { findMany, deleteMany }, 'deleteMany', {
        where,
        limit: 2,
      });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(operation.execute).toHaveBeenCalledWith({ where: { AND: [where, bySerials('s1', 's2')] } });
      expect(produceRecords).toHaveBeenCalledWith([deleteEvent(d1), deleteEvent(d2)], expect.anything(), new Map());
    });

    it.each([
      ['updateMany', { where, data }],
      ['updateManyAndReturn', { where, data }],
      ['updateMany', { where, data, limit: 2 }],
    ] as const)(
      'fails an %s %j of a model with no row key before the write, naming the model',
      async (action, args) => {
        const findMany = vi.fn(async () => []);
        const mutation = vi.fn(async () => ({ count: 0 }));
        const { client, operation } = operationOnModel('Note', { findMany, [action]: mutation }, action, args);

        await expect(runWithRecords(executor, operation, scopeOn(client), produce())).rejects.toThrow(
          NO_ROW_KEY_MESSAGE,
        );
        expect(mutation).not.toHaveBeenCalled();
      },
    );

    it('audits a deleteMany of a model with no row key from the rows read before it', async () => {
      const note: Row = { label: null, text: 't' };
      const findMany = findManyReturning([note]);
      const deleteMany = vi.fn(async () => ({ count: 1 }));
      const { client, operation } = operationOnModel('Note', { findMany, deleteMany }, 'deleteMany', { where });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(deleteMany).toHaveBeenCalledWith({ where });
      expect(produceRecords).toHaveBeenCalledWith(
        [expect.objectContaining({ model: 'Note', action: 'delete', before: { kind: 'captured', row: note } })],
        expect.anything(),
        new Map(),
      );
    });
  });

  describe('rows the read after the write does not find by the key they were read under', () => {
    const c1: Row = { id: 'c', email: 'c@1' };
    const c2: Row = { id: 'c', email: 'c@2' };
    const data = { email: 'x' };
    const report = (action: string, count: number, message: string) => ({
      phase: 'row-identification',
      modelName: 'User',
      operation: action,
      params: { unidentified: count },
      error: new Error(message),
    });
    const notFoundReport = (action: string, count: number) =>
      report(
        action,
        count,
        `${count} of the rows read before an ${action} are not found by key after it, so they are not audited: another writer changed their key or deleted them`,
      );
    const withoutBeforeReport = (action: string, count: number) =>
      report(
        action,
        count,
        `${count} of the rows an ${action} returned pair with no row read before the write by key, so they have no before state`,
      );
    const updateEvent = (before: Row, after: Row, op: string) =>
      eventOf({
        identity: before.id,
        action: 'update',
        before: { kind: 'captured', row: before },
        after,
        origin: { path: '', op },
      });

    it('reports the rows an updateMany re-read does not find by their key, and audits the rows it finds', async () => {
      const findMany = findManyReturning([a1, b1, c1], [b2, c2]);
      const updateMany = vi.fn(async () => ({ count: 3 }));
      const client = clientWith({ user: { findMany, updateMany } });
      const produceRecords = produce();

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where: {}, data }),
        scopeOn(client),
        produceRecords,
      );

      expect(outcome.result).toEqual({ count: 3 });
      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(notFoundReport('updateMany', 1));
      expect(produceRecords).toHaveBeenCalledWith(
        [updateEvent(b1, b2, 'updateMany'), updateEvent(c1, c2, 'updateMany')],
        expect.anything(),
        new Map(),
      );
    });

    it('reports every row an updateMany re-read misses, and audits none when it finds none', async () => {
      const findMany = findManyReturning([a1, b1], []);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const client = clientWith({ user: { findMany, updateMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where: {}, data }),
        scopeOn(client),
        produceRecords,
      );

      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(notFoundReport('updateMany', 2));
      expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
    });

    it('records the rows an updateManyAndReturn returns under a key that no row read before has without a before state, and reports them', async () => {
      const inserted: Row = { id: 'z', email: 'x' };
      const findMany = findManyReturning([b1]);
      const updateManyAndReturn = vi.fn(async () => [inserted, b2]);
      const client = clientWith({ user: { findMany, updateManyAndReturn } });
      const produceRecords = produce();

      const outcome = await runWithRecords(
        executor,
        operationOn(client, 'updateManyAndReturn', { where: {}, data }),
        scopeOn(client),
        produceRecords,
      );

      expect(outcome.result).toEqual([inserted, b2]);
      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(withoutBeforeReport('updateManyAndReturn', 1));
      expect(produceRecords).toHaveBeenCalledWith(
        [
          eventOf({
            identity: 'z',
            action: 'update',
            before: { kind: 'unavailable' },
            after: inserted,
            origin: { path: '', op: 'updateManyAndReturn' },
          }),
          updateEvent(b1, b2, 'updateManyAndReturn'),
        ],
        expect.anything(),
        new Map(),
      );
    });

    it('reports the rows an updateMany with a limit wrote that its re-read does not find by their key, and audits the rows it finds', async () => {
      const findMany = findManyReturning([a1, b1], [b2]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const client = clientWith({ user: { findMany, updateMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where: {}, data, limit: 2 }),
        scopeOn(client),
        produceRecords,
      );

      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(notFoundReport('updateMany', 1));
      expect(produceRecords).toHaveBeenCalledWith([updateEvent(b1, b2, 'updateMany')], expect.anything(), new Map());
    });

    it('reports nothing when every written row pairs by its key', async () => {
      const findMany = findManyReturning([a1, b1], [a2, b2]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const client = clientWith({ user: { findMany, updateMany } });

      await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where: {}, data }),
        scopeOn(client),
        produce(),
      );

      expect(failureSink.notify).not.toHaveBeenCalled();
    });
  });

  describe('a write whose data changes the key of the rows it writes in a way the audit cannot follow', () => {
    const one: Row = { id: 1, value: 'one' };
    const two: Row = { id: 2, value: 'two' };
    const shifted = (row: Row): Row => ({ ...row, id: (row.id as number) + 1 });
    const data = { id: { increment: 1 } };
    const report = (action: string, count: number, message: string) => ({
      phase: 'row-identification',
      modelName: 'Counter',
      operation: action,
      params: { unidentified: count },
      error: new Error(message),
    });
    const notFollowedReport = (action: string, count: number) =>
      report(
        action,
        count,
        `${count} of the rows an ${action} wrote are not audited: its data changes their key in a way the audit cannot follow`,
      );

    it('runs an updateMany that moves one row onto the old key of another as given, reads no row, audits none and reports the rows it wrote', async () => {
      // A read by the keys of the rows read before would find the row that moved onto key 2 and pair it with row 2
      const findMany = findManyReturning([one, two], [shifted(one)]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const { client, operation } = operationOnModel('Counter', { findMany, updateMany }, 'updateMany', {
        where: {},
        data,
      });
      const produceRecords = produce();

      const outcome = await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(outcome.result).toEqual({ count: 2 });
      expect(updateMany).toHaveBeenCalledExactlyOnceWith({ where: {}, data });
      expect(findMany).not.toHaveBeenCalled();
      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(notFollowedReport('updateMany', 2));
      expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
    });

    it('records each row an updateManyAndReturn returns as an update without a before state, reports them, and reads no row', async () => {
      const findMany = findManyReturning([one, two]);
      const updateManyAndReturn = vi.fn(async () => [shifted(two), shifted(one)]);
      const { client, operation } = operationOnModel(
        'Counter',
        { findMany, updateManyAndReturn },
        'updateManyAndReturn',
        { where: {}, data },
      );
      const produceRecords = produce();

      const outcome = await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(outcome.result).toEqual([shifted(two), shifted(one)]);
      expect(findMany).not.toHaveBeenCalled();
      expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(
        report(
          'updateManyAndReturn',
          2,
          '2 of the rows an updateManyAndReturn returned are recorded without a before state: its data changes their key in a way the audit cannot follow',
        ),
      );
      const unavailableUpdate = (after: Row) =>
        expect.objectContaining({
          model: 'Counter',
          identity: String(after.id),
          action: 'update',
          before: { kind: 'unavailable' },
          after,
          origin: { path: '', op: 'updateManyAndReturn' },
        });
      expect(produceRecords).toHaveBeenCalledWith(
        [unavailableUpdate(shifted(two)), unavailableUpdate(shifted(one))],
        expect.anything(),
        new Map(),
      );
    });

    it.each([
      ['outside any transaction', false],
      ['inside an interactive transaction', true],
    ])(
      'runs an updateMany with a limit %s as given, its count the one Prisma returns, reads no row and reports the rows it wrote',
      async (_label, interactive) => {
        const findMany = findManyReturning([one, two]);
        const updateMany = vi.fn(async () => ({ count: 2 }));
        const args = { where: {}, data, limit: 2 };
        const { client, operation } = operationOnModel('Counter', { findMany, updateMany }, 'updateMany', args);
        const produceRecords = produce();

        const outcome = await runWithRecords(
          executor,
          operation,
          interactive ? transactionScopeOn(client) : scopeOn(client),
          produceRecords,
        );

        expect(outcome.result).toEqual({ count: 2 });
        expect(updateMany).toHaveBeenCalledExactlyOnceWith(args);
        expect(findMany).not.toHaveBeenCalled();
        expect(failureSink.notify).toHaveBeenCalledExactlyOnceWith(notFollowedReport('updateMany', 2));
        expect(produceRecords).toHaveBeenCalledWith([], expect.anything(), new Map());
      },
    );
  });

  describe('a write whose data gives the key literal values', () => {
    const d1: Row = { label: null, serial: 's1', name: 'one' };
    const d9: Row = { ...d1, serial: 's9' };
    const deviceUpdate = (before: Row, after: Row, op: string) =>
      expect.objectContaining({
        model: 'Device',
        identity: after.serial,
        action: 'update',
        before: { kind: 'captured', row: before },
        after,
        origin: { path: '', op },
      });

    it('reads the rows of an updateMany again by the key the write gave them, and pairs each with the row it was', async () => {
      const findMany = findManyReturning([d1], [d9]);
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const { client, operation } = operationOnModel('Device', { findMany, updateMany }, 'updateMany', {
        where: { serial: 's1' },
        data: { serial: 's9' },
      });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where: { serial: 's1' } }], [{ where: { serial: { in: ['s9'] } } }]]);
      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith([deviceUpdate(d1, d9, 'updateMany')], expect.anything(), new Map());
    });

    it('pairs each row an updateManyAndReturn returns with the row it was, by the key the write gave it', async () => {
      const findMany = findManyReturning([d1]);
      const updateManyAndReturn = vi.fn(async () => [d9]);
      const { client, operation } = operationOnModel(
        'Device',
        { findMany, updateManyAndReturn },
        'updateManyAndReturn',
        { where: { serial: 's1' }, data: { serial: { set: 's9' } } },
      );
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls).toEqual([[{ where: { serial: 's1' } }]]);
      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(
        [deviceUpdate(d1, d9, 'updateManyAndReturn')],
        expect.anything(),
        new Map(),
      );
    });

    it('audits an updateMany whose data gives the key the value each row already has, as a write that leaves the key alone', async () => {
      const findMany = findManyReturning([a1], [a2]);
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const client = clientWith({ user: { findMany, updateMany } });
      const produceRecords = produce();

      await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where: { id: 'a' }, data: { id: 'a', email: 'a@2' } }),
        scopeOn(client),
        produceRecords,
      );

      expect(findMany.mock.calls).toEqual([[{ where: { id: 'a' } }], [{ where: { id: { in: ['a'] } } }]]);
      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(
        [eventOf({ identity: 'a', before: { kind: 'captured', row: a1 }, after: a2 })],
        expect.anything(),
        new Map(),
      );
    });

    it('leaves out of a top-up round inside an interactive transaction the rows already read, under their old and their new keys, and pairs the written rows by their new keys', async () => {
      const m11: Row = { orgId: 1n, userId: 1n, role: 'member' };
      const m12: Row = { orgId: 1n, userId: 2n, role: 'member' };
      const m91: Row = { ...m11, orgId: 9n };
      const findMany = findManyReturning([m11, m12], [], [m91], [m91]);
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const where = { role: 'member' };
      const data = { orgId: 9n };
      const { client, operation } = operationOnModel('Membership', { findMany, updateMany }, 'updateMany', {
        where,
        data,
        limit: 2,
      });
      const produceRecords = produce();
      const keys = (...pairs: Array<[bigint, bigint]>) => ({
        OR: pairs.map(([orgId, userId]) => ({ orgId, userId })),
      });

      const outcome = await runWithRecords(executor, operation, transactionScopeOn(client), produceRecords);

      expect(outcome.result).toEqual({ count: 1 });
      expect(findMany.mock.calls).toEqual([
        [{ where, take: 2 }],
        [
          {
            where: {
              AND: [
                where,
                {
                  NOT: keys([1n, 1n], [1n, 2n], [9n, 1n], [9n, 2n]),
                },
              ],
            },
            take: 1,
          },
        ],
        [{ where: { AND: [where, keys([9n, 1n], [9n, 2n])] } }],
        [{ where: keys([9n, 1n]) }],
      ]);
      expect(vi.mocked(operation.execute).mock.calls).toEqual([
        [{ where: { AND: [where, keys([1n, 1n], [1n, 2n])] }, data }],
      ]);
      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            model: 'Membership',
            action: 'update',
            before: { kind: 'captured', row: m11 },
            after: m91,
          }),
        ],
        expect.anything(),
        new Map(),
      );
    });
  });

  describe('a write whose data gives a key field a literal in another form than the type Prisma reads it back in', () => {
    const updateOf = (model: string, before: Row, after: Row) =>
      expect.objectContaining({ model, action: 'update', before: { kind: 'captured', row: before }, after });

    it('pairs the rows of an updateMany that gives a DateTime of a composite key as an ISO string', async () => {
      const s0: Row = { room: 'r1', at: new Date('2026-01-01T00:00:00.000Z'), note: 'n' };
      const s1: Row = { ...s0, at: new Date('2026-01-02T03:04:05.000Z') };
      const findMany = findManyReturning([s0], [s1]);
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const { client, operation } = operationOnModel('Slot', { findMany, updateMany }, 'updateMany', {
        where: { room: 'r1' },
        data: { at: '2026-01-02T03:04:05Z' },
      });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(findMany.mock.calls[1]).toEqual([{ where: { OR: [{ room: 'r1', at: s1.at }] } }]);
      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith([updateOf('Slot', s0, s1)], expect.anything(), new Map());
    });

    it('pairs the rows of a limited updateMany inside an interactive transaction that gives a BigInt of a composite key as a number', async () => {
      const m11: Row = { orgId: 1n, userId: 1n, role: 'member' };
      const m91: Row = { ...m11, orgId: 9n };
      const findMany = findManyReturning([m11], [m91]);
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const { client, operation } = operationOnModel('Membership', { findMany, updateMany }, 'updateMany', {
        where: { role: 'member' },
        data: { orgId: 9 },
        limit: 1,
      });
      const produceRecords = produce();

      const outcome = await runWithRecords(executor, operation, transactionScopeOn(client), produceRecords);

      expect(outcome.result).toEqual({ count: 1 });
      expect(findMany.mock.calls[1]).toEqual([{ where: { OR: [{ orgId: 9n, userId: 1n }] } }]);
      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith([updateOf('Membership', m11, m91)], expect.anything(), new Map());
    });

    it('pairs each row an updateManyAndReturn returns when its data gives a Decimal key as a string with a trailing zero', async () => {
      const r0: Row = { amount: new Decimal('1.25'), label: 'base' };
      const r1: Row = { amount: new Decimal('1.5'), label: 'base' };
      const findMany = findManyReturning([r0]);
      const updateManyAndReturn = vi.fn(async () => [r1]);
      const { client, operation } = operationOnModel('Rate', { findMany, updateManyAndReturn }, 'updateManyAndReturn', {
        where: { label: 'base' },
        data: { amount: '1.50' },
      });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(failureSink.notify).not.toHaveBeenCalled();
      expect(produceRecords).toHaveBeenCalledWith([updateOf('Rate', r0, r1)], expect.anything(), new Map());
    });
  });

  describe('on a client that takes a query omit, whatever a client-level omit hides', () => {
    const where = { email: { contains: '@' } };
    const data = { email: 'x' };
    const READS_ID = { omit: { id: false } };
    const c1: Row = { id: 'c', email: 'c@1' };
    const c2: Row = { id: 'c', email: 'c@2' };

    beforeEach(() => {
      executor = createExecutor(failureSink, true);
    });

    it('reads the primary key in the read before an updateMany and in the read after it', async () => {
      const findMany = findManyReturning([a1, b1], [a2, b2]);
      const client = clientWith({ user: { findMany, updateMany: vi.fn(async () => ({ count: 2 })) } });

      await runWithRecords(executor, operationOn(client, 'updateMany', { where, data }), scopeOn(client), produce());

      expect(findMany.mock.calls).toEqual([
        [{ where, ...READS_ID }],
        [{ where: { id: { in: ['a', 'b'] } }, ...READS_ID }],
      ]);
    });

    it('reads the primary key in the read before an updateManyAndReturn', async () => {
      const findMany = findManyReturning([a1]);
      const updateManyAndReturn = vi.fn(async () => [a2]);
      const client = clientWith({ user: { findMany, updateManyAndReturn } });

      await runWithRecords(
        executor,
        operationOn(client, 'updateManyAndReturn', { where, data }),
        scopeOn(client),
        produce(),
      );

      expect(findMany.mock.calls).toEqual([[{ where, ...READS_ID }]]);
    });

    it('reads the primary key in the read before a deleteMany', async () => {
      const findMany = findManyReturning([a1]);
      const client = clientWith({ user: { findMany, deleteMany: vi.fn(async () => ({ count: 1 })) } });

      await runWithRecords(executor, operationOn(client, 'deleteMany', { where }), scopeOn(client), produce());

      expect(findMany.mock.calls).toEqual([[{ where, ...READS_ID }]]);
    });

    it('reads the primary key in every read of a limited updateMany, a short round and the read after the write included', async () => {
      const findMany = findManyReturning([a1, b1], [c1], [a1], [a2, c2]);
      const updateMany = vi.fn<() => Promise<{ count: number }>>();
      updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
      const client = clientWith({ user: { findMany, updateMany } });

      await runWithRecords(
        executor,
        operationOn(client, 'updateMany', { where, data, limit: 2 }),
        transactionScopeOn(client),
        produce(),
      );

      expect(findMany.mock.calls).toEqual([
        [{ where, take: 2, ...READS_ID }],
        [{ where: { AND: [where, { NOT: { id: { in: ['a', 'b'] } } }] }, take: 1, ...READS_ID }],
        [{ where: { AND: [where, { id: { in: ['a', 'b'] } }] }, ...READS_ID }],
        [{ where: { id: { in: ['a', 'c'] } }, ...READS_ID }],
      ]);
    });

    it('reads the primary key in every read of a limited deleteMany, a short round included', async () => {
      const findMany = findManyReturning([a1, b1], [c1], [b1]);
      const deleteMany = vi.fn<() => Promise<{ count: number }>>();
      deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
      const client = clientWith({ user: { findMany, deleteMany } });

      await runWithRecords(
        executor,
        operationOn(client, 'deleteMany', { where, limit: 2 }),
        transactionScopeOn(client),
        produce(),
      );

      expect(findMany.mock.calls).toEqual([
        [{ where, take: 2, ...READS_ID }],
        [{ where: { AND: [where, { NOT: { id: { in: ['a', 'b'] } } }] }, take: 1, ...READS_ID }],
        [{ where: { id: { in: ['a', 'b'] } }, ...READS_ID }],
      ]);
    });

    it('reads the unique field of a model without a primary key, and no extra field of a model with no row key', async () => {
      const deviceFindMany = findManyReturning([{ label: null, serial: 's1', name: 'one' }]);
      const device = operationOnModel(
        'Device',
        { findMany: deviceFindMany, deleteMany: vi.fn(async () => ({ count: 1 })) },
        'deleteMany',
        { where },
      );
      const noteFindMany = findManyReturning([{ label: null, text: 't' }]);
      const note = operationOnModel(
        'Note',
        { findMany: noteFindMany, deleteMany: vi.fn(async () => ({ count: 1 })) },
        'deleteMany',
        { where },
      );

      await runWithRecords(executor, device.operation, scopeOn(device.client), produce());
      await runWithRecords(executor, note.operation, scopeOn(note.client), produce());

      expect(deviceFindMany.mock.calls).toEqual([[{ where, omit: { serial: false } }]]);
      expect(noteFindMany.mock.calls).toEqual([[{ where }]]);
    });
  });

  describe('a model whose primary key is a DateTime', () => {
    const t0 = new Date('2026-01-02T03:04:05.000Z');
    const t1 = new Date('2026-01-02T03:04:05.001Z');
    const readingEvent = (fields: Row) => expect.objectContaining({ model: 'Reading', ...fields });

    it('pairs the rows of an updateMany by their key when two keys differ by one millisecond', async () => {
      const findMany = findManyReturning(
        [
          { at: t0, value: 'zero' },
          { at: t1, value: 'one' },
        ],
        [
          { at: t1, value: 'one!' },
          { at: t0, value: 'zero!' },
        ],
      );
      const delegate = { findMany, updateMany: vi.fn(async () => ({ count: 2 })) };
      const { client, operation } = operationOnModel('Reading', delegate, 'updateMany', {
        where: {},
        data: { value: 'x' },
      });
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(produceRecords).toHaveBeenCalledWith(
        [
          readingEvent({
            identity: t1.toISOString(),
            before: { kind: 'captured', row: { at: t1, value: 'one' } },
            after: { at: t1, value: 'one!' },
          }),
          readingEvent({
            identity: t0.toISOString(),
            before: { kind: 'captured', row: { at: t0, value: 'zero' } },
            after: { at: t0, value: 'zero!' },
          }),
        ],
        expect.anything(),
        new Map(),
      );
      expect(failureSink.notify).not.toHaveBeenCalled();
    });

    it('audits both rows a createMany inserted under keys that differ by one millisecond', async () => {
      const createMany = vi.fn(async () => ({ count: 2 }));
      const findMany = findManyReturning([
        { at: t1, value: 'one' },
        { at: t0, value: 'zero' },
      ]);
      const { client, operation } = createManyOn(
        'Reading',
        { createMany, findMany },
        {
          data: [
            { at: t0, value: 'zero' },
            { at: t1, value: 'one' },
          ],
        },
      );
      const produceRecords = produce();

      await runWithRecords(executor, operation, scopeOn(client), produceRecords);

      expect(produceRecords).toHaveBeenCalledWith(
        [
          readingEvent({ identity: t0.toISOString(), after: { at: t0, value: 'zero' } }),
          readingEvent({ identity: t1.toISOString(), after: { at: t1, value: 'one' } }),
        ],
        expect.anything(),
        new Map(),
      );
      expect(failureSink.notify).not.toHaveBeenCalled();
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
