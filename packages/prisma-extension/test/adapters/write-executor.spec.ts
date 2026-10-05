/**
 * Tests for the default Prisma write executor: which record fields reach the audit-log model.
 */

import type { AuditRecord } from '@kuruwic/db-audit-core';
import { createActorId, createAggregateId, createEntityId } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { createPrismaWriteExecutor, declaresBeforeUnavailableColumn } from '../../src/adapters/write-executor.js';

const DbNull = Symbol('DbNull');

const record: AuditRecord = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('u1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'Post',
  entityId: createEntityId('p1'),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'Post',
  aggregateId: createAggregateId('p1'),
  aggregateContext: null,
  action: 'update',
  before: null,
  after: { id: 'p1' },
  changes: null,
  beforeUnavailable: true,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const clientWithAuditLog = () => {
  const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
  return { client: { auditLog: { create } }, create };
};

const dmmfWith = (fields: Array<{ name: string; kind: string; type: string; isList?: boolean }>) => ({
  datamodel: { models: [{ name: 'AuditLog', fields }] },
});

describe('createPrismaWriteExecutor', () => {
  it('writes to the audit-log model it was constructed for', async () => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
    const client = { activity: { create } };

    await createPrismaWriteExecutor(DbNull, { auditLogModel: 'activity', storesBeforeUnavailable: false }).write(
      client,
      [record],
    );

    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ entityId: 'p1' }) });
  });

  it('leaves beforeUnavailable out of the row when the audit-log model has no column for it', async () => {
    const { client, create } = clientWithAuditLog();

    await createPrismaWriteExecutor(DbNull, { auditLogModel: 'auditLog', storesBeforeUnavailable: false }).write(
      client,
      [record],
    );

    const data = create.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty('beforeUnavailable');
    expect(data?.before).toBe(DbNull);
  });

  it('writes beforeUnavailable when the audit-log model has a column for it', async () => {
    const { client, create } = clientWithAuditLog();

    await createPrismaWriteExecutor(DbNull, { auditLogModel: 'auditLog', storesBeforeUnavailable: true }).write(
      client,
      [record],
    );

    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ beforeUnavailable: true }) });
  });
});

describe('the inserts a write issues', () => {
  const recordOf = (id: string): AuditRecord => ({
    ...record,
    entityId: createEntityId(id),
    aggregateId: createAggregateId(id),
  });
  const auditLogDelegate = (withCreateMany: boolean) => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
    const createMany = vi.fn(async (_args: { data: Record<string, unknown>[] }) => ({ count: 0 }));
    return { client: { auditLog: withCreateMany ? { create, createMany } : { create } }, create, createMany };
  };
  const write = (client: Record<string, unknown>, records: AuditRecord[]) =>
    createPrismaWriteExecutor(DbNull, { auditLogModel: 'auditLog', storesBeforeUnavailable: false }).write(
      client,
      records,
    );

  it('issues no insert for no record', async () => {
    const { client, create, createMany } = auditLogDelegate(true);

    await write(client, []);

    expect(create).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('inserts a single record with create even when the model has createMany', async () => {
    const { client, create, createMany } = auditLogDelegate(true);

    await write(client, [recordOf('p1')]);

    expect(create.mock.calls.map(([args]) => args.data.entityId)).toEqual(['p1']);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('inserts several records with one createMany when the model has it', async () => {
    const { client, create, createMany } = auditLogDelegate(true);

    await write(client, [recordOf('p1'), recordOf('p2')]);

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]?.[0].data.map((row) => row.entityId)).toEqual(['p1', 'p2']);
    expect(create).not.toHaveBeenCalled();
  });

  it('inserts several records with one create each, in order, when the model has no createMany', async () => {
    const { client, create } = auditLogDelegate(false);

    await write(client, [recordOf('p1'), recordOf('p2'), recordOf('p3')]);

    expect(create.mock.calls.map(([args]) => args.data.entityId)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('declaresBeforeUnavailableColumn', () => {
  it('is true for a Boolean beforeUnavailable field of the audit-log model', () => {
    const dmmf = dmmfWith([{ name: 'beforeUnavailable', kind: 'scalar', type: 'Boolean' }]);

    expect(declaresBeforeUnavailableColumn(dmmf, 'auditLog')).toBe(true);
  });

  it('is false when the audit-log model has no such field', () => {
    const dmmf = dmmfWith([{ name: 'before', kind: 'scalar', type: 'Json' }]);

    expect(declaresBeforeUnavailableColumn(dmmf, 'auditLog')).toBe(false);
  });

  it('is false when the audit-log model is not in the schema', () => {
    expect(declaresBeforeUnavailableColumn(dmmfWith([]), 'activity')).toBe(false);
  });

  it('throws for a beforeUnavailable field that is not a single Boolean', () => {
    const dmmf = dmmfWith([{ name: 'beforeUnavailable', kind: 'scalar', type: 'String' }]);

    expect(() => declaresBeforeUnavailableColumn(dmmf, 'auditLog')).toThrow(/beforeUnavailable.*Boolean/);
  });
});
