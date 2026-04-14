/**
 * Tests that buildAuditLog serializes all JSON-bound fields (before, after, changes,
 * actorContext, entityContext, aggregateContext, requestContext) via serializeAuditLogData.
 *
 * Verifies that BigInt values in any field are converted to strings before Prisma write.
 */

import type { LoggableEntity } from '@kuruwic/prisma-audit-core';
import { UNHANDLED } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { buildAuditLog, type ResolvedAggregateData } from '../src/audit-log-builder/index.js';
import type { PrismaClientManager } from '../src/client-manager/index.js';
import type { AuditLogData } from '../src/types.js';

const createEntityConfig = (): LoggableEntity => ({
  category: 'model',
  type: 'Transaction',
  idResolver: async (entity: unknown) => (entity as Record<string, unknown>).id as string,
  aggregates: [],
});

const createAggregateConfig = (entityConfig?: LoggableEntity) => {
  const config = entityConfig ?? createEntityConfig();
  return {
    getEntityConfig: vi.fn().mockReturnValue(config),
    isLoggable: vi.fn().mockReturnValue(true),
    getAllLoggableModels: vi.fn().mockReturnValue(['Transaction']),
    getMapping: vi.fn(),
  };
};

const createManager = (): PrismaClientManager => ({
  baseClient: {} as never,
  activeClient: {} as never,
});

const createSelfAggregateData = (entityId: string): ResolvedAggregateData => ({
  aggregateRoots: [{ aggregateCategory: 'model', aggregateType: 'Transaction', aggregateId: entityId }],
  aggregateContexts: new Map([['Transaction', null]]),
});

describe('buildAuditLog serialization', () => {
  it('should serialize BigInt in before/after fields', async () => {
    const entity = { id: 'tx-1', amount: 100n, status: 'completed' };
    const before = { id: 'tx-1', amount: 50n, status: 'pending' };

    const logs = await buildAuditLog(
      entity,
      'update',
      { actor: { category: 'model', type: 'User', id: 'user-1' } },
      'Transaction',
      createManager(),
      null,
      null,
      before,
      createAggregateConfig(),
      undefined,
      undefined,
      createSelfAggregateData('tx-1'),
      undefined,
      undefined,
    );

    expect(logs.length).toBeGreaterThan(0);
    const log = logs[0] as AuditLogData;

    const after = log.after as Record<string, unknown>;
    expect(after.amount).toBe('100');

    const beforeData = log.before as Record<string, unknown>;
    expect(beforeData.amount).toBe('50');

    const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
    const amountChange = changes.amount as { old: unknown; new: unknown };
    expect(amountChange.old).toBe('50');
    expect(amountChange.new).toBe('100');
  });

  it('should serialize BigInt in context fields', async () => {
    const entity = { id: 'tx-1', name: 'test' };
    const actorContext = { walletId: 999n };
    const entityContext = { blockNumber: 12345n };

    const logs = await buildAuditLog(
      entity,
      'create',
      {
        actor: { category: 'model', type: 'User', id: 'user-1' },
        request: { traceId: 42n },
      },
      'Transaction',
      createManager(),
      actorContext,
      entityContext,
      null,
      createAggregateConfig(),
      undefined,
      undefined,
      createSelfAggregateData('tx-1'),
      undefined,
      undefined,
    );

    expect(logs.length).toBeGreaterThan(0);
    const log = logs[0] as AuditLogData;

    const actor = log.actorContext as Record<string, unknown>;
    expect(actor.walletId).toBe('999');

    const entityCtx = log.entityContext as Record<string, unknown>;
    expect(entityCtx.blockNumber).toBe('12345');

    const request = log.requestContext as Record<string, unknown>;
    expect(request.traceId).toBe('42');
  });

  it('should serialize Date in context fields', async () => {
    const entity = { id: 'tx-1', name: 'test' };
    const actorContext = { lastLogin: new Date('2025-06-01T00:00:00.000Z') };

    const logs = await buildAuditLog(
      entity,
      'create',
      { actor: { category: 'model', type: 'User', id: 'user-1' } },
      'Transaction',
      createManager(),
      actorContext,
      null,
      null,
      createAggregateConfig(),
      undefined,
      undefined,
      createSelfAggregateData('tx-1'),
      undefined,
      undefined,
    );

    expect(logs.length).toBeGreaterThan(0);
    const log = logs[0] as AuditLogData;
    const actor = log.actorContext as Record<string, unknown>;
    expect(actor.lastLogin).toBe('2025-06-01T00:00:00.000Z');
  });

  it('should apply custom serializers from SerializationConfig', async () => {
    const entity = { id: 'tx-1', name: 'test' };
    const actorContext = { data: new Uint8Array([1, 2, 3]) };

    const logs = await buildAuditLog(
      entity,
      'create',
      { actor: { category: 'model', type: 'User', id: 'user-1' } },
      'Transaction',
      createManager(),
      actorContext,
      null,
      null,
      createAggregateConfig(),
      undefined,
      undefined,
      createSelfAggregateData('tx-1'),
      undefined,
      {
        customSerializers: [
          (value: unknown) => {
            if (value instanceof Uint8Array) return `bytes:${value.length}`;
            return UNHANDLED;
          },
        ],
      },
    );

    expect(logs.length).toBeGreaterThan(0);
    const log = logs[0] as AuditLogData;
    const actor = log.actorContext as Record<string, unknown>;
    expect(actor.data).toBe('bytes:3');
  });
});
