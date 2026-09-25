/**
 * Tests for audit record production: events are resolved and composed in one pass, and the
 * user's callbacks receive the scope's handle, the client of the transaction the operation runs
 * in when there is one.
 */

import type { MutationEvent } from '@kuruwic/prisma-audit-core';
import { createAggregateConfig, defineEntity } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import { createRecordProducer } from '../../src/pipeline/produce-records.js';

const baseClient: PrismaClientWithDynamicAccess = Object.assign(Object.create(null), { name: 'base' });
const transactionClient: TransactionalPrismaClient = Object.assign(Object.create(null), { name: 'transaction' });
const auditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

const scopeOn = (handle: ExecutionScope['handle']): ExecutionScope => ({
  auditContext,
  handle,
  baseHandle: baseClient,
  transaction: handle === baseClient ? undefined : { deferredWrites: [], implicit: true },
  atomic: true,
});

const event: MutationEvent = {
  model: 'Post',
  identity: 'p1',
  action: 'update',
  before: { id: 'p1', title: 'old' },
  after: { id: 'p1', title: 'new' },
  origin: { path: '', op: 'update' },
};

const producerWith = (idResolver: (row: Record<string, unknown>, db: unknown) => Promise<string | null>) => {
  const service = createAggregateConfig({ Post: defineEntity({ type: 'Post', idResolver }) });
  return createRecordProducer({
    resolveConfig: { entity: service.getEntityConfig, rootEntity: service.getEntityConfigByType },
    composeConfig: { entity: service.getEntityConfig, excludeFields: [], relationFieldNames: () => undefined },
  });
};

describe('createRecordProducer', () => {
  it('composes the records of the resolved events', async () => {
    const produce = producerWith(async (row) => row.id as string);

    const records = await produce([event], scopeOn(baseClient));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      entityType: 'Post',
      entityId: 'p1',
      aggregateType: 'Post',
      aggregateId: 'p1',
      action: 'update',
      before: event.before,
      after: event.after,
      changes: { title: { old: 'old', new: 'new' } },
    });
  });

  it('hands the callbacks the base client when the operation runs outside a transaction', async () => {
    const idResolver = vi.fn(async (row: Record<string, unknown>) => row.id as string);

    await producerWith(idResolver)([event], scopeOn(baseClient));

    expect(idResolver).toHaveBeenCalledWith(event.after, baseClient);
  });

  it('hands the callbacks the transaction client when the operation runs in a transaction', async () => {
    const idResolver = vi.fn(async (row: Record<string, unknown>) => row.id as string);

    await producerWith(idResolver)([event], scopeOn(transactionClient));

    expect(idResolver).toHaveBeenCalledWith(event.after, transactionClient);
    expect(idResolver).not.toHaveBeenCalledWith(event.after, baseClient);
  });
});
