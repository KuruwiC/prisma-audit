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
  create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id })),
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

  it.each([
    ['createEntityNormalizedWriter', () => createEntityNormalizedWriter(entitySchema), entityModels, 'auditEvent'],
    ['createSharedChangeWriter', () => createSharedChangeWriter(sharedChangeSchema), sharedChangeModels, 'auditChange'],
  ] as const)(
    '%s rejects naming the handle when the write is outside a transaction and the handle has no $transaction',
    async (_name, makeWriter, models, created) => {
      const handleModels: Models = models();

      await expect(makeWriter()([record], contextOn(handleModels, false))).rejects.toThrow(
        '[@prisma-audit] The normalized writer cannot open a transaction on the handle it was given: it has no $transaction',
      );
      expect(handleModels[created]?.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['createEntityNormalizedWriter', () => createEntityNormalizedWriter(entitySchema)],
    ['createSharedChangeWriter', () => createSharedChangeWriter(sharedChangeSchema)],
  ] as const)(
    '%s rejects a handle that is neither an object nor a function, inside a transaction or not',
    async (_name, makeWriter) => {
      for (const handle of [undefined, null, 'client', 42]) {
        for (const inTransaction of [true, false]) {
          await expect(makeWriter()([record], contextOn(handle, inTransaction))).rejects.toThrow(
            '[@prisma-audit] The normalized writer needs a Prisma client or transaction client as its handle',
          );
        }
      }
    },
  );

  it.each([
    ['createEntityNormalizedWriter', () => createEntityNormalizedWriter(entitySchema), entityModels, 'auditEvent'],
    ['createSharedChangeWriter', () => createSharedChangeWriter(sharedChangeSchema), sharedChangeModels, 'auditChange'],
  ] as const)(
    '%s writes on a handle whose typeof is function, which carries the models and $transaction',
    async (_name, makeWriter, models, created) => {
      const { client, clientModels, transactionModels, $transaction } = clientOutsideTransaction(models);
      const functionHandle = Object.assign(() => undefined, client);

      await makeWriter()([record], contextOn(functionHandle, false));

      expect(typeof functionHandle).toBe('function');
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(transactionModels[created]?.create).toHaveBeenCalledTimes(1);
      expect(clientModels[created]?.create).not.toHaveBeenCalled();

      await makeWriter()(
        [record],
        contextOn(
          Object.assign(() => undefined, clientModels),
          true,
        ),
      );

      expect(clientModels[created]?.create).toHaveBeenCalledTimes(1);
    },
  );
});

describe('the beforeUnavailable marker of the normalized writers', () => {
  const unavailableRecord: AuditRecord = { ...record, action: 'update', before: null, beforeUnavailable: true };

  const entityModels = () => ({
    actor: modelDelegate('actor-1'),
    entity: modelDelegate('entity-1'),
    aggregate: modelDelegate('aggregate-1'),
    auditEvent: modelDelegate('event-1'),
  });
  const entitySchema = {
    actorModel: 'actor',
    entityModel: 'entity',
    aggregateModel: 'aggregate',
    eventModel: 'auditEvent',
  };
  const sharedChangeSchema = { changeModel: 'auditChange', aggregateModel: 'auditAggregate' };

  it('is stored in the event field the entity-normalized schema names', async () => {
    const tx = entityModels();
    const writer = createEntityNormalizedWriter({ ...entitySchema, beforeUnavailableField: 'beforeMissing' });

    await writer([unavailableRecord], contextOn(tx));

    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ beforeMissing: true }) });
  });

  it('is left out of the event when the entity-normalized schema names no field for it', async () => {
    const tx = entityModels();
    const writer = createEntityNormalizedWriter(entitySchema);

    await writer([unavailableRecord], contextOn(tx));

    const data = tx.auditEvent.create.mock.calls[0]?.[0].data ?? {};
    expect(Object.keys(data)).not.toContain('beforeUnavailable');
    expect(Object.keys(data)).not.toContain('beforeMissing');
  });

  it('is stored in the change field the shared-change schema names', async () => {
    const tx = { auditChange: modelDelegate('change-1'), auditAggregate: modelDelegate('link-1') };
    const writer = createSharedChangeWriter({ ...sharedChangeSchema, beforeUnavailableField: 'beforeUnavailable' });

    await writer([unavailableRecord], contextOn(tx));

    expect(tx.auditChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({ beforeUnavailable: true }) });
  });

  it('is left out of the change when the shared-change schema names no field for it', async () => {
    const tx = { auditChange: modelDelegate('change-1'), auditAggregate: modelDelegate('link-1') };
    const writer = createSharedChangeWriter(sharedChangeSchema);

    await writer([unavailableRecord], contextOn(tx));

    const data = tx.auditChange.create.mock.calls[0]?.[0].data ?? {};
    expect(Object.keys(data)).not.toContain('beforeUnavailable');
  });
});

describe('a write the normalized writers cannot make', () => {
  const entitySchema = {
    actorModel: 'actor',
    entityModel: 'entity',
    aggregateModel: 'aggregate',
    eventModel: 'auditEvent',
  };
  const sharedChangeSchema = { changeModel: 'auditChange', aggregateModel: 'auditAggregate' };
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
  const without = <T extends Record<string, unknown>>(models: T, name: keyof T) => {
    const { [name]: _removed, ...rest } = models;
    return rest;
  };

  describe('with no audit log', () => {
    it.each([
      ['createEntityNormalizedWriter', createEntityNormalizedWriter(entitySchema), entityModels, 'auditEvent'],
      ['createSharedChangeWriter', createSharedChangeWriter(sharedChangeSchema), sharedChangeModels, 'auditChange'],
    ] as const)('%s opens no transaction and writes nothing', async (_name, writer, makeModels, created) => {
      const models: Record<string, ReturnType<typeof modelDelegate>> = makeModels();
      const $transaction = vi.fn(async (run: (tx: unknown) => Promise<void>) => run(models));

      await writer([], contextOn({ ...models, $transaction }, false));

      expect($transaction).not.toHaveBeenCalled();
      expect(models[created]?.create).not.toHaveBeenCalled();
    });
  });

  describe('with a model the client does not have, or one without the operation the writer needs', () => {
    it.each([
      ['the actor model', 'actor', 'upsert'],
      ['the entity model', 'entity', 'upsert'],
      ['the aggregate model', 'aggregate', 'upsert'],
      ['the event model', 'auditEvent', 'create'],
    ] as const)('the entity-normalized writer rejects without %s', async (_label, missing, operation) => {
      const models = without(entityModels(), missing);

      await expect(createEntityNormalizedWriter(entitySchema)([record], contextOn(models))).rejects.toThrow(
        `Model "${missing}" not found or does not support ${operation} operation`,
      );
    });

    it.each([
      ['the change model', 'auditChange'],
      ['the aggregate model', 'auditAggregate'],
    ] as const)('the shared-change writer rejects without %s', async (_label, missing) => {
      const models = without(sharedChangeModels(), missing);

      await expect(createSharedChangeWriter(sharedChangeSchema)([record], contextOn(models))).rejects.toThrow(
        `Model "${missing}" not found or does not support create operation`,
      );
    });

    it('rejects a model whose operation is not a function, naming the operation', async () => {
      const models = { ...entityModels(), actor: { upsert: 'not a function' } };

      await expect(createEntityNormalizedWriter(entitySchema)([record], contextOn(models))).rejects.toThrow(
        'Model "actor" not found or does not support upsert operation',
      );
    });
  });
});
