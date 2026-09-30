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

const contextOn = (handle: unknown, inTransaction = true): WriteContext => ({
  auditContext: { actor: { category: 'model', type: 'User', id: 'u1' } },
  handle,
  inTransaction,
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

describe('the transaction the normalized writers write in', () => {
  const entitySchema = {
    actorModel: 'actor',
    entityModel: 'entity',
    aggregateModel: 'aggregate',
    eventModel: 'auditEvent',
  };
  const sharedChangeSchema = { changeModel: 'auditChange', aggregateModel: 'auditAggregate' };

  type Models = Record<string, ReturnType<typeof modelDelegate>>;

  /** A client outside any transaction: it opens one and runs the callback on the client of that transaction */
  const clientOutsideTransaction = (makeModels: () => Models) => {
    const transactionModels = makeModels();
    const clientModels = makeModels();
    const $transaction = vi.fn(async (run: (tx: unknown) => Promise<void>) => run(transactionModels));
    return { client: { ...clientModels, $transaction }, clientModels, transactionModels, $transaction };
  };

  const entityModels = () => ({
    actor: modelDelegate('actor-1'),
    entity: modelDelegate('entity-1'),
    aggregate: modelDelegate('aggregate-1'),
    auditEvent: modelDelegate('event-1'),
  });
  const sharedChangeModels = () => ({
    auditChange: modelDelegate('change-1'),
    auditAggregate: modelDelegate('link-1'),
  });

  it.each([
    ['createEntityNormalizedWriter', () => createEntityNormalizedWriter(entitySchema), entityModels, 'auditEvent'],
    ['createSharedChangeWriter', () => createSharedChangeWriter(sharedChangeSchema), sharedChangeModels, 'auditChange'],
  ] as const)(
    '%s opens a transaction of its own when the write is outside one',
    async (_name, makeWriter, models, created) => {
      const { client, clientModels, transactionModels, $transaction } = clientOutsideTransaction(models);

      await makeWriter()([record], contextOn(client, false));

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(transactionModels[created]?.create).toHaveBeenCalledTimes(1);
      expect(clientModels[created]?.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['createEntityNormalizedWriter', () => createEntityNormalizedWriter(entitySchema), entityModels, 'auditEvent'],
    ['createSharedChangeWriter', () => createSharedChangeWriter(sharedChangeSchema), sharedChangeModels, 'auditChange'],
  ] as const)(
    '%s writes on the handle without opening a transaction when the write is inside one',
    async (_name, makeWriter, models, created) => {
      const { client, clientModels, $transaction } = clientOutsideTransaction(models);

      await makeWriter()([record], contextOn(client, true));

      expect($transaction).not.toHaveBeenCalled();
      expect(clientModels[created]?.create).toHaveBeenCalledTimes(1);
    },
  );
});
