/**
 * Tests for the build-logs stages
 *
 * The single-operation stage collects the events of the executed operation and the batch stage
 * one event per written row; both produce the audit records through `produceRecords`.
 */

import { createActorId, createAggregateId, createEntityId } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../src/internal-types.js';
import { createBatchBuildLogsStage } from '../src/lifecycle/batch-stages.js';
import { createBuildLogsStage } from '../src/lifecycle/stages.js';
import type { BatchInitialContext, ExecutedContext } from '../src/lifecycle/types.js';
import type { AuditLogData } from '../src/types.js';
import { createSchemaMetadataFromDMMF } from '../src/utils/schema-metadata.js';

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'Post',
          fields: [
            { name: 'id', kind: 'scalar', type: 'String', isId: true },
            { name: 'title', kind: 'scalar', type: 'String' },
          ],
        },
      ],
    },
  },
});

const auditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };
const clientStub: PrismaClientWithDynamicAccess = Object.create(null);

const log: AuditLogData = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'content',
  entityType: 'Post',
  entityId: createEntityId('post-1'),
  entityContext: null,
  aggregateCategory: 'content',
  aggregateType: 'Post',
  aggregateId: createAggregateId('post-1'),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 'post-1', title: 'New Title' },
  changes: null,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const createDeps = () => ({
  schemaMetadata,
  getNestedOperationConfig: () => ({ fetchBeforeOperation: true }),
  produceRecords: vi.fn().mockResolvedValue([log]),
});

describe('createBuildLogsStage', () => {
  const executedContext = (): ExecutedContext => ({
    operation: { model: 'Post', action: 'create', args: { data: { title: 'New Title' } } },
    auditContext,
    clientToUse: clientStub,
    query: vi.fn(),
    beforeState: null,
    beforeStateResult: { _tag: 'notRequested' },
    nestedPreFetchResults: new Map(),
    result: { id: 'post-1', title: 'New Title' },
  });

  it('collects the events of the executed operation and produces their records', async () => {
    const deps = createDeps();
    const context = executedContext();

    const finalContext = await createBuildLogsStage(deps)(context);

    expect(deps.produceRecords).toHaveBeenCalledWith(
      [
        {
          model: 'Post',
          identity: 'post-1',
          action: 'create',
          before: undefined,
          after: context.result,
          origin: { path: '', op: 'create' },
        },
      ],
      auditContext,
    );
    expect(finalContext.logs).toEqual([log]);
  });

  it('preserves the executed context', async () => {
    const context = executedContext();

    const finalContext = await createBuildLogsStage(createDeps())(context);

    expect(finalContext).toMatchObject(context);
  });
});

describe('createBatchBuildLogsStage', () => {
  it('collects one event per row, paired with its before state, and produces their records', async () => {
    const deps = createDeps();
    const rows = [
      { id: 'p1', title: 'A2' },
      { id: 'p2', title: 'B2' },
    ];
    const beforeStates = [{ id: 'p1', title: 'A1' }, null];
    const context: BatchInitialContext = {
      operation: { model: 'Post', action: 'updateMany', args: { data: {} } },
      auditContext,
      clientToUse: clientStub,
      entities: rows,
      beforeStates,
    };

    const finalContext = await createBatchBuildLogsStage(deps)(context);

    expect(deps.produceRecords).toHaveBeenCalledWith(
      [
        {
          model: 'Post',
          identity: 'p1',
          action: 'update',
          before: beforeStates[0],
          after: rows[0],
          origin: { path: '', op: 'updateMany' },
        },
        {
          model: 'Post',
          identity: 'p2',
          action: 'update',
          before: undefined,
          after: rows[1],
          origin: { path: '', op: 'updateMany' },
        },
      ],
      auditContext,
    );
    expect(finalContext.logs).toEqual([log]);
    expect(finalContext.result).toBeUndefined();
  });
});
