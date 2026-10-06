/**
 * Tests for the operation executor: the order of its steps, and that the records are built only
 * when asked for, after the write has run.
 */

import type { AuditRecord, MutationEvent } from '@kuruwic/db-audit-core';
import { createActorId, createAggregateId, createEntityId } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import { type AuditedOperation, createExecutor } from '../../src/pipeline/executor.js';
import type { AuditLogData } from '../../src/types.js';

const record: AuditLogData = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'User',
  entityId: createEntityId('u1'),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'User',
  aggregateId: createAggregateId('u1'),
  aggregateContext: null,
  action: 'update',
  before: { id: 'u1', name: 'Ann' },
  after: { id: 'u1', name: 'Anne' },
  changes: { name: { old: 'Ann', new: 'Anne' } },
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const transactionClient: TransactionalPrismaClient = Object.assign(Object.create(null), { name: 'transaction' });
const baseClient: PrismaClientWithDynamicAccess = {
  $transaction: async () => {
    throw new Error('not used');
  },
  $extends: () => undefined,
};

const scope: ExecutionScope = {
  auditContext: { actor: { category: 'model', type: 'User', id: 'user-1' } },
  handle: transactionClient,
  baseClient,
  inPrismaBatch: false,
  atomic: true,
};

const operationOf = (): AuditedOperation => ({
  model: 'User',
  action: 'update',
  widened: new Map(),
  args: { where: { id: 'u1' }, data: { name: 'Anne' } },
  execute: vi.fn(),
});

describe('createExecutor', () => {
  it('runs prepare, execute and result, then collect and produce only when the records are built', async () => {
    const calls: string[] = [];
    const step = <T>(name: string, value: T) =>
      vi.fn(async (): Promise<T> => {
        calls.push(name);
        return value;
      });
    const prepared = { before: null };
    const executed = { id: 'u1' };
    const events: MutationEvent[] = [
      { model: 'User', identity: 'u1', action: 'update', before: { kind: 'none' }, origin: { path: '', op: 'update' } },
    ];
    const steps = {
      prepare: step('prepare', prepared),
      execute: step('execute', executed),
      collect: step('collect', events),
      result: step('result', 'returned'),
    };
    const produceRecords = vi.fn(async (): Promise<AuditRecord[]> => {
      calls.push('produce');
      return [record];
    });
    const operation = operationOf();

    const run = await createExecutor(steps).run(operation, scope, produceRecords);

    expect(calls).toEqual(['prepare', 'execute', 'result']);
    expect(run.result).toBe('returned');
    expect(steps.execute).toHaveBeenCalledWith(operation, scope, prepared);
    expect(steps.result).toHaveBeenCalledWith(executed);

    await expect(run.buildRecords()).resolves.toEqual([record]);

    expect(calls).toEqual(['prepare', 'execute', 'result', 'collect', 'produce']);
    expect(steps.collect).toHaveBeenCalledWith(operation, scope, prepared, executed);
    expect(produceRecords).toHaveBeenCalledWith(events, scope, new Map());
  });

  it('stops at the first failing step', async () => {
    const execute = vi.fn(async () => {
      throw new Error('execute failed');
    });
    const collect = vi.fn(async () => []);
    const executor = createExecutor({
      prepare: async () => undefined,
      execute,
      collect,
      result: async () => undefined,
    });

    await expect(executor.run(operationOf(), scope, vi.fn())).rejects.toThrow('execute failed');

    expect(collect).not.toHaveBeenCalled();
  });
});
