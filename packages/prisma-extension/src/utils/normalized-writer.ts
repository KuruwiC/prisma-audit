/**
 * Normalized Writer Utilities
 *
 * Provides custom audit log writers for normalized database schemas.
 * Avoids data duplication by normalizing actors, entities, and aggregates
 * into separate tables, referenced by foreign keys.
 *
 * Supported schemas:
 * 1. Entity-normalized: Separate tables for Actor, Entity, Aggregate, Event
 * 2. Shared-change: Single Change table linked to multiple Aggregates
 *
 * @module utils/normalized-writer
 */

import type { AuditRecord, WriteContext } from '@kuruwic/db-audit-core';
import type { PrismaBaseClient, PrismaHandle } from '../internal-types.js';
import type { AuditLogWriter } from '../types.js';
import { getModelDelegate, hasOperation } from './model-accessor.js';

/**
 * Entity-normalized schema configuration
 */
export interface NormalizedSchema {
  /** Model name for actor table */
  actorModel: string;
  /** Model name for entity table */
  entityModel: string;
  /** Model name for aggregate table */
  aggregateModel: string;
  /** Model name for audit event table */
  eventModel: string;
  /**
   * Field of the event model that stores `AuditRecord.beforeUnavailable` (the before state was
   * requested and could not be read). When omitted the marker is not stored.
   */
  beforeUnavailableField?: string;
}

/**
 * Shared-change schema configuration
 */
export interface SharedChangeSchema {
  /** Model name for change table */
  changeModel: string;
  /** Model name for aggregate relation table */
  aggregateModel: string;
  /**
   * Field of the change model that stores `AuditRecord.beforeUnavailable` (the before state was
   * requested and could not be read). When omitted the marker is not stored.
   */
  beforeUnavailableField?: string;
}

interface DeduplicationResult {
  actors: Map<string, ActorData>;
  entities: Map<string, EntityData>;
  aggregates: Map<string, AggregateData>;
}

interface ActorData {
  category: string;
  type: string;
  externalId: string;
  context: unknown;
}

interface EntityData {
  category: string;
  type: string;
  externalId: string;
  context: unknown;
}

interface AggregateData {
  category: string;
  type: string;
  externalId: string;
  context: unknown;
}

const getActorKey = (log: AuditRecord): string => {
  return `${log.actorCategory}:${log.actorType}:${log.actorId}`;
};

const getEntityKey = (log: AuditRecord): string => {
  return `${log.entityCategory}:${log.entityType}:${log.entityId}`;
};

const getAggregateKey = (log: AuditRecord): string => {
  return `${log.aggregateCategory}:${log.aggregateType}:${log.aggregateId}`;
};

const deduplicateData = (logs: AuditRecord[]): DeduplicationResult => {
  const actors = new Map<string, ActorData>();
  const entities = new Map<string, EntityData>();
  const aggregates = new Map<string, AggregateData>();

  for (const log of logs) {
    const actorKey = getActorKey(log);
    if (!actors.has(actorKey)) {
      actors.set(actorKey, {
        category: log.actorCategory,
        type: log.actorType,
        externalId: log.actorId,
        context: log.actorContext,
      });
    }

    const entityKey = getEntityKey(log);
    if (!entities.has(entityKey)) {
      entities.set(entityKey, {
        category: log.entityCategory,
        type: log.entityType,
        externalId: log.entityId,
        context: log.entityContext,
      });
    }

    const aggregateKey = getAggregateKey(log);
    if (!aggregates.has(aggregateKey)) {
      aggregates.set(aggregateKey, {
        category: log.aggregateCategory,
        type: log.aggregateType,
        externalId: log.aggregateId,
        context: log.aggregateContext,
      });
    }
  }

  return { actors, entities, aggregates };
};

interface UpsertDelegate {
  upsert: (args: unknown) => Promise<{ id: string }>;
}

interface CreateDelegate {
  create: (args: unknown) => Promise<{ id: string }>;
}

const requireDelegate = <TDelegate extends object>(
  tx: PrismaHandle,
  modelName: string,
  operation: keyof TDelegate & string,
): TDelegate => {
  const delegate = getModelDelegate(tx, modelName);
  if (!hasOperation<TDelegate>(delegate, operation)) {
    throw new Error(`Model "${modelName}" not found or does not support ${operation} operation`);
  }
  return delegate;
};

const beforeUnavailableColumn = (field: string | undefined, log: AuditRecord): Record<string, boolean> =>
  field === undefined ? {} : { [field]: log.beforeUnavailable };

/**
 * Batch upserts actors and returns a mapping of keys to IDs
 *
 * @internal
 */
const batchUpsertActors = async (
  tx: PrismaHandle,
  modelName: string,
  actors: Map<string, ActorData>,
): Promise<Map<string, string>> => {
  const actorMap = new Map<string, string>();
  const model = requireDelegate<UpsertDelegate>(tx, modelName, 'upsert');

  for (const [key, actorData] of actors) {
    const actor = await model.upsert({
      where: {
        category_type_externalId: {
          category: actorData.category,
          type: actorData.type,
          externalId: actorData.externalId,
        },
      },
      create: actorData,
      update: { context: actorData.context },
    });
    actorMap.set(key, actor.id);
  }

  return actorMap;
};

/**
 * Batch upserts entities and returns a mapping of keys to IDs
 *
 * @internal
 */
const batchUpsertEntities = async (
  tx: PrismaHandle,
  modelName: string,
  entities: Map<string, EntityData>,
): Promise<Map<string, string>> => {
  const entityMap = new Map<string, string>();
  const model = requireDelegate<UpsertDelegate>(tx, modelName, 'upsert');

  for (const [key, entityData] of entities) {
    const entity = await model.upsert({
      where: {
        category_type_externalId: {
          category: entityData.category,
          type: entityData.type,
          externalId: entityData.externalId,
        },
      },
      create: entityData,
      update: { context: entityData.context },
    });
    entityMap.set(key, entity.id);
  }

  return entityMap;
};

/**
 * Batch upserts aggregates and returns a mapping of keys to IDs
 *
 * @internal
 */
const batchUpsertAggregates = async (
  tx: PrismaHandle,
  modelName: string,
  aggregates: Map<string, AggregateData>,
): Promise<Map<string, string>> => {
  const aggregateMap = new Map<string, string>();
  const model = requireDelegate<UpsertDelegate>(tx, modelName, 'upsert');

  for (const [key, aggregateData] of aggregates) {
    const aggregate = await model.upsert({
      where: {
        category_type_externalId: {
          category: aggregateData.category,
          type: aggregateData.type,
          externalId: aggregateData.externalId,
        },
      },
      create: aggregateData,
      update: { context: aggregateData.context },
    });
    aggregateMap.set(key, aggregate.id);
  }

  return aggregateMap;
};

/**
 * Creates audit events with foreign key references
 *
 * @internal
 */
const createAuditEvents = async (
  tx: PrismaHandle,
  schema: Pick<NormalizedSchema, 'eventModel' | 'beforeUnavailableField'>,
  logs: AuditRecord[],
  actorMap: Map<string, string>,
  entityMap: Map<string, string>,
  aggregateMap: Map<string, string>,
): Promise<void> => {
  const model = requireDelegate<CreateDelegate>(tx, schema.eventModel, 'create');

  for (const log of logs) {
    const actorKey = getActorKey(log);
    const entityKey = getEntityKey(log);
    const aggregateKey = getAggregateKey(log);

    const actorId = actorMap.get(actorKey);
    const entityId = entityMap.get(entityKey);
    const aggregateId = aggregateMap.get(aggregateKey);

    if (!actorId || !entityId || !aggregateId) {
      throw new Error(
        `Failed to resolve foreign keys: actorId=${actorId}, entityId=${entityId}, aggregateId=${aggregateId}`,
      );
    }

    await model.create({
      data: {
        actorId,
        entityId,
        aggregateId,
        action: log.action,
        before: log.before,
        after: log.after,
        changes: log.changes,
        ...beforeUnavailableColumn(schema.beforeUnavailableField, log),
        requestContext: log.requestContext,
        createdAt: log.createdAt,
      },
    });
  }
};

const isPrismaHandle = (handle: unknown): handle is PrismaHandle =>
  (typeof handle === 'object' && handle !== null) || typeof handle === 'function';

const canOpenTransaction = (handle: PrismaHandle): handle is PrismaHandle & Pick<PrismaBaseClient, '$transaction'> =>
  typeof handle.$transaction === 'function';

/**
 * Runs `write` on the writer's handle when the write is already inside a transaction, else in a
 * transaction opened on the handle, which is then a client outside any transaction
 */
const writeInTransaction = (
  { handle, inTransaction }: Pick<WriteContext, 'handle' | 'inTransaction'>,
  write: (tx: PrismaHandle) => Promise<void>,
): Promise<void> => {
  if (!isPrismaHandle(handle)) {
    throw new Error('[@prisma-audit] The normalized writer needs a Prisma client or transaction client as its handle');
  }
  if (inTransaction) {
    return write(handle);
  }
  if (!canOpenTransaction(handle)) {
    throw new Error(
      '[@prisma-audit] The normalized writer cannot open a transaction on the handle it was given: it has no $transaction',
    );
  }
  return handle.$transaction(write);
};

/**
 * Creates a writer that stores audit logs in a normalized schema with separate tables for actors,
 * entities, aggregates and events, so their metadata is not duplicated across audit logs. Writes run
 * on the handle the writer receives: in the audited operation's transaction when the write is inside
 * it (`inTransaction`), else in a transaction of their own.
 *
 * @example
 * ```typescript
 * const prisma = createAuditClient(basePrisma, {
 *   provider,
 *   aggregateMapping,
 *   Prisma,
 *   hooks: {
 *     writer: createEntityNormalizedWriter({
 *       actorModel: 'actor',
 *       entityModel: 'entity',
 *       aggregateModel: 'aggregate',
 *       eventModel: 'auditEvent',
 *     }),
 *   },
 * });
 * ```
 */
export const createEntityNormalizedWriter = (schema: NormalizedSchema): AuditLogWriter => {
  return async (logs, context) => {
    if (logs.length === 0) {
      return;
    }

    const { actors, entities, aggregates } = deduplicateData(logs);

    const writeWithinTransaction = async (tx: PrismaHandle) => {
      const actorMap = await batchUpsertActors(tx, schema.actorModel, actors);
      const entityMap = await batchUpsertEntities(tx, schema.entityModel, entities);
      const aggregateMap = await batchUpsertAggregates(tx, schema.aggregateModel, aggregates);

      await createAuditEvents(tx, schema, logs, actorMap, entityMap, aggregateMap);
    };

    await writeInTransaction(context, writeWithinTransaction);
  };
};

const getChangeKey = (log: AuditRecord): string => {
  return `${log.entityCategory}:${log.entityType}:${log.entityId}:${log.action}`;
};

const groupLogsByChange = (logs: AuditRecord[]): Map<string, AuditRecord[]> => {
  const groups = new Map<string, AuditRecord[]>();

  for (const log of logs) {
    const key = getChangeKey(log);
    const existing = groups.get(key);
    if (existing) {
      existing.push(log);
    } else {
      groups.set(key, [log]);
    }
  }

  return groups;
};

/**
 * Creates a writer that stores each entity change (before/after/changes) once and links it to every
 * aggregate root it belongs to, so change data is not duplicated across aggregates. Writes run on
 * the handle the writer receives: in the audited operation's transaction when the write is inside it
 * (`inTransaction`), else in a transaction of their own.
 *
 * @example
 * ```typescript
 * const prisma = createAuditClient(basePrisma, {
 *   provider,
 *   aggregateMapping,
 *   Prisma,
 *   hooks: {
 *     writer: createSharedChangeWriter({
 *       changeModel: 'auditChange',
 *       aggregateModel: 'auditAggregate',
 *     }),
 *   },
 * });
 * ```
 */
export const createSharedChangeWriter = (schema: SharedChangeSchema): AuditLogWriter => {
  return async (logs, context) => {
    if (logs.length === 0) {
      return;
    }

    const changeGroups = groupLogsByChange(logs);

    const createChangeRecord = async (
      changeModel: { create: (args: { data: unknown }) => Promise<{ id: string }> },
      representativeLog: AuditRecord,
    ): Promise<{ id: string }> => {
      return changeModel.create({
        data: {
          entityCategory: representativeLog.entityCategory,
          entityType: representativeLog.entityType,
          entityId: representativeLog.entityId,
          action: representativeLog.action,
          before: representativeLog.before,
          after: representativeLog.after,
          changes: representativeLog.changes,
          ...beforeUnavailableColumn(schema.beforeUnavailableField, representativeLog),
          createdAt: representativeLog.createdAt,
        },
      });
    };

    const createAggregateRecords = async (
      aggregateModel: { create: (args: { data: unknown }) => Promise<unknown> },
      changeId: string,
      groupedLogs: readonly AuditRecord[],
    ): Promise<void> => {
      for (const log of groupedLogs) {
        await aggregateModel.create({
          data: {
            changeId,
            actorCategory: log.actorCategory,
            actorType: log.actorType,
            actorId: log.actorId,
            actorContext: log.actorContext,
            aggregateCategory: log.aggregateCategory,
            aggregateType: log.aggregateType,
            aggregateId: log.aggregateId,
            aggregateContext: log.aggregateContext,
            entityContext: log.entityContext,
            requestContext: log.requestContext,
          },
        });
      }
    };

    const processChangeGroups = async (
      changeModel: { create: (args: { data: unknown }) => Promise<{ id: string }> },
      aggregateModel: { create: (args: { data: unknown }) => Promise<unknown> },
      changeGroups: Map<string, AuditRecord[]>,
    ): Promise<void> => {
      for (const [_changeKey, groupedLogs] of changeGroups) {
        const representativeLog = groupedLogs[0];
        if (!representativeLog) {
          continue;
        }

        const change = await createChangeRecord(changeModel, representativeLog);
        await createAggregateRecords(aggregateModel, change.id, groupedLogs);
      }
    };

    const writeWithinTransaction = async (tx: PrismaHandle) => {
      const changeModel = requireDelegate<CreateDelegate>(tx, schema.changeModel, 'create');
      const aggregateModel = requireDelegate<CreateDelegate>(tx, schema.aggregateModel, 'create');

      await processChangeGroups(changeModel, aggregateModel, changeGroups);
    };

    await writeInTransaction(context, writeWithinTransaction);
  };
};
