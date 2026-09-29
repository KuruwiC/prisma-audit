/**
 * Tests for the normalized writers' model lookup on the handle they write on.
 *
 * Prisma exposes a model declared as `model auditEvent` only under `auditEvent`: its client resolves
 * a property by the property itself or by the property with its first letter uppercased, never by
 * lowercasing it. The fake transaction clients below expose each model under that one key.
 */

import type { AuditRecord, WriteContext } from '@kuruwic/db-audit-core';
import { createActorId, createAggregateId, createEntityId } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { createEntityNormalizedWriter, createSharedChangeWriter } from '../../src/utils/normalized-writer.js';

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
  aggregateType: 'User',
  aggregateId: createAggregateId('u1'),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 'p1' },
  changes: null,
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const contextOn = (handle: unknown): WriteContext => ({
  auditContext: { actor: { category: 'model', type: 'User', id: 'u1' } },
  handle,
  defaultWrite: async () => {},
});

const modelDelegate = (id: string) => ({
  upsert: vi.fn(async () => ({ id })),
  create: vi.fn(async () => ({ id })),
});

describe('createEntityNormalizedWriter', () => {
  it('writes on models declared with a lowercase first letter', async () => {
    const tx = {
      actor: modelDelegate('actor-1'),
      entity: modelDelegate('entity-1'),
      aggregate: modelDelegate('aggregate-1'),
      auditEvent: modelDelegate('event-1'),
    };
    const writer = createEntityNormalizedWriter({
      actorModel: 'actor',
      entityModel: 'entity',
      aggregateModel: 'aggregate',
      eventModel: 'auditEvent',
    });

    await writer([record], contextOn(tx));

    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: 'actor-1', entityId: 'entity-1', aggregateId: 'aggregate-1' }),
    });
  });
});

describe('createSharedChangeWriter', () => {
  it('writes on models declared with a lowercase first letter', async () => {
    const tx = { auditChange: modelDelegate('change-1'), auditAggregate: modelDelegate('link-1') };
    const writer = createSharedChangeWriter({ changeModel: 'auditChange', aggregateModel: 'auditAggregate' });

    await writer([record], contextOn(tx));

    expect(tx.auditAggregate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ changeId: 'change-1', aggregateId: 'u1' }),
    });
  });
});
