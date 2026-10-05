/**
 * Tests for audit record production: events are resolved and composed in one pass, and the
 * user's callbacks receive the scope's handle, the client of the transaction the operation runs
 * in when there is one.
 */

import type { FailureSink, MutationEvent } from '@kuruwic/db-audit-core';
import { createEntityConfigLookup, defineEntity } from '@kuruwic/db-audit-core';
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
  baseClient,
  transaction: handle === baseClient ? undefined : { deferredWrites: [] },
  inPrismaBatch: false,
  atomic: true,
});

const event: MutationEvent = {
  model: 'Post',
  identity: 'p1',
  action: 'update',
  before: { kind: 'captured', row: { id: 'p1', title: 'old' } },
  after: { id: 'p1', title: 'new' },
  origin: { path: '', op: 'update' },
};

const producerWith = (
  idResolver: (row: Record<string, unknown>, db: unknown) => Promise<string | null>,
  failureSink: Pick<FailureSink, 'reportResolverFailures'> = { reportResolverFailures: vi.fn(async () => {}) },
) => {
  const entityConfigs = createEntityConfigLookup({ Post: defineEntity({ type: 'Post', idResolver }) });
  return createRecordProducer({
    resolveConfig: { entity: entityConfigs.byModel, rootEntity: entityConfigs.byCategoryAndType },
    composeConfig: { entity: entityConfigs.byModel, excludeFields: [], relationFieldNames: () => undefined },
    failureSink,
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
      before: { id: 'p1', title: 'old' },
      beforeUnavailable: false,
      after: event.after,
      changes: { title: { old: 'old', new: 'new' } },
    });
  });

  it('reports the row whose id resolver throws to the failure sink and composes the other rows', async () => {
    const error = new Error('resolver broken');
    const reportResolverFailures = vi.fn(async () => {});
    const failing: MutationEvent = {
      ...event,
      identity: 'p2',
      after: { id: 'p2', title: 'new' },
      origin: { path: 'posts', op: 'create' },
    };
    const produce = producerWith(
      async (row) => {
        if (row.id === 'p2') throw error;
        return row.id as string;
      },
      { reportResolverFailures },
    );

    const records = await produce([event, failing], scopeOn(baseClient));

    expect(records.map((record) => record.entityId)).toEqual(['p1']);
    expect(reportResolverFailures).toHaveBeenCalledTimes(1);
    expect(reportResolverFailures).toHaveBeenCalledWith([{ event: failing, resolver: { kind: 'entity' }, error }]);
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
