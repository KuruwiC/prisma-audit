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
import type { OmittedFieldReadDependencies } from '../../src/pipeline/omitted-fields-after-write.js';
import { createRecordProducer } from '../../src/pipeline/produce-records.js';
import { createAuditedOmittedFields, NO_AUDITED_OMITTED_FIELDS } from '../../src/utils/audited-omitted-fields.js';
import { column, model, schemaMetadataOf } from '../support/audit-schema.js';

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

const postSchemaMetadata = schemaMetadataOf(
  model('Post', [column('id', { isId: true }), column('title'), column('secret')]),
);

const producerWith = (
  idResolver: (row: Record<string, unknown>, db: unknown) => Promise<string | null>,
  failureSink: Pick<FailureSink, 'reportResolverFailures'> = { reportResolverFailures: vi.fn(async () => {}) },
  omittedFieldReads: OmittedFieldReadDependencies = {
    schemaMetadata: schemaMetadataOf(),
    auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
  },
) => {
  const entityConfigs = createEntityConfigLookup({ Post: defineEntity({ type: 'Post', idResolver }) });
  return createRecordProducer({
    resolveConfig: { entity: entityConfigs.byModel, rootEntity: entityConfigs.byCategoryAndType },
    composeConfig: { entity: entityConfigs.byModel, excludeFields: [], relationFieldNames: () => undefined },
    omittedFieldReads,
    failureSink,
  });
};

describe('createRecordProducer', () => {
  it('composes the records of the resolved events', async () => {
    const produce = producerWith(async (row) => row.id as string);

    const records = await produce([event], scopeOn(baseClient), new Map());

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

    const records = await produce([event, failing], scopeOn(baseClient), new Map());

    expect(records.map((record) => record.entityId)).toEqual(['p1']);
    expect(reportResolverFailures).toHaveBeenCalledTimes(1);
    expect(reportResolverFailures).toHaveBeenCalledWith([{ event: failing, resolver: { kind: 'entity' }, error }]);
  });

  it('hands the callbacks the base client when the operation runs outside a transaction', async () => {
    const idResolver = vi.fn(async (row: Record<string, unknown>) => row.id as string);

    await producerWith(idResolver)([event], scopeOn(baseClient), new Map());

    expect(idResolver).toHaveBeenCalledWith(event.after, baseClient);
  });

  it('hands the callbacks the transaction client when the operation runs in a transaction', async () => {
    const idResolver = vi.fn(async (row: Record<string, unknown>) => row.id as string);

    await producerWith(idResolver)([event], scopeOn(transactionClient), new Map());

    expect(idResolver).toHaveBeenCalledWith(event.after, transactionClient);
    expect(idResolver).not.toHaveBeenCalledWith(event.after, baseClient);
  });

  it('leaves the widened columns of a created row out of the stored after state', async () => {
    const created: MutationEvent = {
      model: 'Post',
      identity: 'p1',
      action: 'create',
      before: { kind: 'none' },
      after: { id: 'p1', title: 'new', secret: 'hidden' },
      origin: { path: '', op: 'create' },
    };
    const produce = producerWith(async (row) => row.id as string);

    const [widenedRecord] = await produce([created], scopeOn(baseClient), new Map([['Post', new Set(['secret'])]]));
    const [plainRecord] = await produce([created], scopeOn(baseClient), new Map());

    expect(widenedRecord?.after).toEqual({ id: 'p1', title: 'new' });
    expect(plainRecord?.after).toEqual({ id: 'p1', title: 'new', secret: 'hidden' });
  });

  it('reads the omitted fields an entity audits on the handle of the scope, completing the stored after state', async () => {
    const baseFindMany = vi.fn(async () => [{ id: 'p1', secret: 'read-on-base' }]);
    const transactionFindMany = vi.fn(async () => [{ id: 'p1', secret: 'read-after-write' }]);
    const base: PrismaClientWithDynamicAccess = Object.assign(Object.create(null), {
      post: { findMany: baseFindMany },
    });
    const transaction: TransactionalPrismaClient = Object.assign(Object.create(null), {
      post: { findMany: transactionFindMany },
    });
    const produce = producerWith(
      async (row) => row.id as string,
      { reportResolverFailures: vi.fn(async () => {}) },
      {
        schemaMetadata: postSchemaMetadata,
        auditedOmittedFields: createAuditedOmittedFields(
          (model) => (model === 'Post' ? { auditOmittedFields: ['secret'] } : undefined),
          [],
        ),
      },
    );

    const written: MutationEvent = {
      ...event,
      before: { kind: 'captured', row: { id: 'p1', title: 'old', secret: 'old-secret' } },
    };

    const [record] = await produce([written], { ...scopeOn(transaction), baseClient: base }, new Map());

    expect(transactionFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1'] } },
      select: { id: true, secret: true },
    });
    expect(baseFindMany).not.toHaveBeenCalled();
    expect(record?.after).toEqual({ id: 'p1', title: 'new', secret: 'read-after-write' });
  });
});
