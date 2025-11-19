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
 * @module normalized-writer
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { AuditLogData, AuditLogWriter } from '../types.js';

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
}

/**
 * Shared-change schema configuration
 */
export interface SharedChangeSchema {
  /** Model name for change table */
  changeModel: string;
  /** Model name for aggregate relation table */
  aggregateModel: string;
}

/**
 * Deduplication result for actors, entities, and aggregates
 *
 * @internal
 */
interface DeduplicationResult {
  actors: Map<string, ActorData>;
  entities: Map<string, EntityData>;
  aggregates: Map<string, AggregateData>;
}

/**
 * Actor data structure
 *
 * @internal
 */
interface ActorData {
  category: string;
  type: string;
  externalId: string;
  context: unknown;
}

/**
 * Entity data structure
 *
 * @internal
 */
interface EntityData {
  category: string;
  type: string;
  externalId: string;
  context: unknown;
}

/**
 * Aggregate data structure
 *
 * @internal
 */
interface AggregateData {
  category: string;
  type: string;
  externalId: string;
  context: unknown;
}

/**
 * Capitalizes the first letter of a string to match Prisma model naming convention
 *
 * @internal
 */
const capitalizeModelName = (name: string): string => {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * Creates a unique key for an actor
 *
 * @internal
 */
const getActorKey = (log: AuditLogData): string => {
  return `${log.actorCategory}:${log.actorType}:${log.actorId}`;
};

/**
 * Creates a unique key for an entity
 *
 * @internal
 */
const getEntityKey = (log: AuditLogData): string => {
  return `${log.entityCategory}:${log.entityType}:${log.entityId}`;
};

/**
 * Creates a unique key for an aggregate
 *
 * @internal
 */
const getAggregateKey = (log: AuditLogData): string => {
  return `${log.aggregateCategory}:${log.aggregateType}:${log.aggregateId}`;
};

/**
 * Deduplicates actors, entities, and aggregates from audit log data
 *
 * @internal
 */
const deduplicateData = (logs: AuditLogData[]): DeduplicationResult => {
  const actors = new Map<string, ActorData>();
  const entities = new Map<string, EntityData>();
  const aggregates = new Map<string, AggregateData>();

  for (const log of logs) {
    // Deduplicate actors
    const actorKey = getActorKey(log);
    if (!actors.has(actorKey)) {
      actors.set(actorKey, {
        category: log.actorCategory,
        type: log.actorType,
        externalId: log.actorId,
        context: log.actorContext,
      });
    }

    // Deduplicate entities
    const entityKey = getEntityKey(log);
    if (!entities.has(entityKey)) {
      entities.set(entityKey, {
        category: log.entityCategory,
        type: log.entityType,
        externalId: log.entityId,
        context: log.entityContext,
      });
    }

    // Deduplicate aggregates
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

/**
 * Transaction client type
 *
 * @internal
 */
type TransactionClient = Record<
  string,
  {
    upsert?: (args: unknown) => Promise<{ id: string }>;
    create?: (args: unknown) => Promise<{ id: string }>;
    [key: string]: unknown;
  }
>;

/**
 * Batch upserts actors and returns a mapping of keys to IDs
 *
 * @internal
 */
const batchUpsertActors = async (
  tx: TransactionClient,
  modelName: string,
  actors: Map<string, ActorData>,
): Promise<Map<string, string>> => {
  const actorMap = new Map<string, string>();
  const capitalizedModelName = capitalizeModelName(modelName);
  const model = tx[capitalizedModelName];

  if (!model || typeof model.upsert !== 'function') {
    throw new Error(`Model "${capitalizedModelName}" not found or does not support upsert operation`);
  }

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
  tx: TransactionClient,
  modelName: string,
  entities: Map<string, EntityData>,
): Promise<Map<string, string>> => {
  const entityMap = new Map<string, string>();
  const capitalizedModelName = capitalizeModelName(modelName);
  const model = tx[capitalizedModelName];

  if (!model || typeof model.upsert !== 'function') {
    throw new Error(`Model "${capitalizedModelName}" not found or does not support upsert operation`);
  }

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
  tx: TransactionClient,
  modelName: string,
  aggregates: Map<string, AggregateData>,
): Promise<Map<string, string>> => {
  const aggregateMap = new Map<string, string>();
  const capitalizedModelName = capitalizeModelName(modelName);
  const model = tx[capitalizedModelName];

  if (!model || typeof model.upsert !== 'function') {
    throw new Error(`Model "${capitalizedModelName}" not found or does not support upsert operation`);
  }

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
  tx: TransactionClient,
  modelName: string,
  logs: AuditLogData[],
  actorMap: Map<string, string>,
  entityMap: Map<string, string>,
  aggregateMap: Map<string, string>,
): Promise<void> => {
  const capitalizedModelName = capitalizeModelName(modelName);
  const model = tx[capitalizedModelName];

  if (!model || typeof model.create !== 'function') {
    throw new Error(`Model "${capitalizedModelName}" not found or does not support create operation`);
  }

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
        requestContext: log.requestContext,
        createdAt: log.createdAt,
      },
    });
  }
};

/**
 * Creates an entity-normalized audit log writer
 *
 * Creates a custom writer that stores audit logs in a normalized schema
 * with separate tables for actors, entities, aggregates, and events.
 * Prevents duplication of actor/entity/aggregate metadata across audit logs.
 *
 * @example
 * ```typescript
 * const prisma = createAuditClient(basePrisma, {
 *   provider,
 *   aggregateMapping,
 *   basePrisma,
 *   hooks: {
 *     writer: createEntityNormalizedWriter(
 *       {
 *         actorModel: 'actor',
 *         entityModel: 'entity',
 *         aggregateModel: 'aggregate',
 *         eventModel: 'auditEvent',
 *       },
 *       basePrisma,
 *     ),
 *   },
 * });
 * ```
 */
/**
 * Base Prisma client type with transaction support
 *
 * @internal
 */
type PrismaClientWithTransaction = {
  $transaction: <T>(fn: (tx: TransactionClient) => Promise<T>) => Promise<T>;
};

export const createEntityNormalizedWriter = (schema: NormalizedSchema, basePrisma: unknown): AuditLogWriter => {
  return async (
    logs: AuditLogData[],
    context: AuditContext,
    _defaultWrite: (logs: AuditLogData[]) => Promise<void>,
  ) => {
    if (logs.length === 0) {
      return;
    }

    const { actors, entities, aggregates } = deduplicateData(logs);

    const writeWithinTransaction = async (tx: TransactionClient) => {
      const actorMap = await batchUpsertActors(tx, schema.actorModel, actors);
      const entityMap = await batchUpsertEntities(tx, schema.entityModel, entities);
      const aggregateMap = await batchUpsertAggregates(tx, schema.aggregateModel, aggregates);

      await createAuditEvents(tx, schema.eventModel, logs, actorMap, entityMap, aggregateMap);
    };

    if (context.transactionalClient) {
      await writeWithinTransaction(context.transactionalClient as TransactionClient);
    } else {
      const prismaClient = basePrisma as PrismaClientWithTransaction;
      await prismaClient.$transaction(writeWithinTransaction);
    }
  };
};

/**
 * Creates a key for grouping logs by entity change
 *
 * @internal
 */
const getChangeKey = (log: AuditLogData): string => {
  return `${log.entityCategory}:${log.entityType}:${log.entityId}:${log.action}`;
};

/**
 * Groups logs by entity change
 *
 * @internal
 */
const groupLogsByChange = (logs: AuditLogData[]): Map<string, AuditLogData[]> => {
  const groups = new Map<string, AuditLogData[]>();

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
 * Creates a shared-change audit log writer
 *
 * Creates a custom writer that stores audit logs in a normalized schema
 * where change data (before/after/changes) is stored once and linked to multiple aggregate roots.
 * Prevents duplication of change data when an entity belongs to multiple aggregates.
 *
 * @example
 * ```typescript
 * const prisma = createAuditClient(basePrisma, {
 *   provider,
 *   aggregateMapping,
 *   basePrisma,
 *   hooks: {
 *     writer: createSharedChangeWriter(
 *       {
 *         changeModel: 'auditChange',
 *         aggregateModel: 'auditAggregate',
 *       },
 *       basePrisma,
 *     ),
 *   },
 * });
 * ```
 */
export const createSharedChangeWriter = (schema: SharedChangeSchema, basePrisma: unknown): AuditLogWriter => {
  return async (
    logs: AuditLogData[],
    context: AuditContext,
    _defaultWrite: (logs: AuditLogData[]) => Promise<void>,
  ) => {
    if (logs.length === 0) {
      return;
    }

    // Group logs by entity change
    const changeGroups = groupLogsByChange(logs);

    /**
     * Create a change record from representative log
     */
    const createChangeRecord = async (
      changeModel: { create: (args: { data: unknown }) => Promise<{ id: string }> },
      representativeLog: AuditLogData,
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
          createdAt: representativeLog.createdAt,
        },
      });
    };

    /**
     * Create aggregate records for a change
     */
    const createAggregateRecords = async (
      aggregateModel: { create: (args: { data: unknown }) => Promise<unknown> },
      changeId: string,
      groupedLogs: readonly AuditLogData[],
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

    /**
     * Process change groups and create records
     */
    const processChangeGroups = async (
      changeModel: { create: (args: { data: unknown }) => Promise<{ id: string }> },
      aggregateModel: { create: (args: { data: unknown }) => Promise<unknown> },
      changeGroups: Map<string, AuditLogData[]>,
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

    /**
     * Write logic to be executed within transaction
     */
    const writeWithinTransaction = async (tx: TransactionClient) => {
      const capitalizedChangeModel = capitalizeModelName(schema.changeModel);
      const capitalizedAggregateModel = capitalizeModelName(schema.aggregateModel);

      const changeModel = tx[capitalizedChangeModel];
      const aggregateModel = tx[capitalizedAggregateModel];

      if (!changeModel || typeof changeModel.create !== 'function') {
        throw new Error(`Model "${capitalizedChangeModel}" not found or does not support create operation`);
      }

      if (!aggregateModel || typeof aggregateModel.create !== 'function') {
        throw new Error(`Model "${capitalizedAggregateModel}" not found or does not support create operation`);
      }

      await processChangeGroups(
        changeModel as { create: (args: { data: unknown }) => Promise<{ id: string }> },
        aggregateModel as { create: (args: { data: unknown }) => Promise<unknown> },
        changeGroups,
      );
    };

    // Execute within appropriate context
    if (context.transactionalClient) {
      // Already in a transaction - use the transactional client directly
      await writeWithinTransaction(context.transactionalClient as TransactionClient);
    } else {
      // Not in a transaction - wrap in transaction using basePrisma
      const prismaClient = basePrisma as PrismaClientWithTransaction;
      await prismaClient.$transaction(writeWithinTransaction);
    }
  };
};
