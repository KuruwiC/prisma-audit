/**
 * Audit log builder module
 *
 * Builds the audit rows of one written entity: resolves the entity id through the entity's
 * idResolver, then composes one record per pre-resolved aggregate root.
 *
 * @module audit-log-builder
 */

import type {
  AggregateConfigService,
  AuditContext,
  MutationAction,
  ResolvedEvent,
  ResolvedId,
  SerializationConfig,
} from '@kuruwic/prisma-audit-core';
import { compose, normalizeId, type RedactConfig } from '@kuruwic/prisma-audit-core';
import type { PrismaClientManager } from '../client-manager/index.js';
import type { AuditLogData, PrismaAction } from '../types.js';

/**
 * Pre-resolved aggregate data for an entity.
 *
 * Separates aggregate resolution from audit log construction,
 * enabling batch optimization at the caller level.
 */
export type ResolvedAggregateData = {
  readonly aggregateRoots: ResolvedId[];
  /** Keyed by composite root identity: `aggregateType:aggregateId` */
  readonly aggregateContexts: Map<string, unknown>;
};

/** Composite key for aggregate context: root identity = type + id */
export const aggregateContextKey = (aggregateType: string, aggregateId: string): string =>
  `${aggregateType}:${aggregateId}`;

/** Action stored in the audit row: upsert resolves by the presence of a before state, batch keywords to their singular action */
const toMutationAction = (action: PrismaAction, before: Record<string, unknown> | null | undefined): MutationAction => {
  switch (action) {
    case 'create':
    case 'createMany':
    case 'createManyAndReturn':
      return 'create';
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      return 'update';
    case 'delete':
    case 'deleteMany':
      return 'delete';
    case 'upsert':
      return before ? 'update' : 'create';
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`[@prisma-audit] Unknown action: ${exhaustiveCheck}`);
    }
  }
};

export interface BuildAuditLogInput {
  entity: Record<string, unknown>;
  action: PrismaAction;
  context: AuditContext;
  modelName: string;
  manager: PrismaClientManager;
  actorContext: unknown;
  entityContext: unknown;
  before: Record<string, unknown> | null | undefined;
  aggregateConfig: AggregateConfigService;
  excludeFields: string[] | undefined;
  redact: RedactConfig | undefined;
  aggregateData: ResolvedAggregateData;
  includeRelations?: boolean;
  serialization?: SerializationConfig;
  relationFieldNames?: Set<string>;
}

/**
 * Build audit log data for an entity
 *
 * Returns an empty array when the entity config is missing, no aggregate root resolved,
 * the idResolver returned no id, or (updates only) only excluded fields changed.
 */
export const buildAuditLog = async (input: BuildAuditLogInput): Promise<AuditLogData[]> => {
  const {
    entity,
    action,
    context,
    modelName,
    manager,
    actorContext,
    entityContext,
    before,
    aggregateConfig,
    excludeFields,
    redact,
    aggregateData,
    includeRelations,
    serialization,
    relationFieldNames,
  } = input;

  const entityConfig = aggregateConfig.getEntityConfig(modelName);
  if (!entityConfig) {
    return [];
  }

  const { aggregateRoots, aggregateContexts } = aggregateData;
  if (aggregateRoots.length === 0) {
    return [];
  }

  const entityIdResult = await entityConfig.idResolver(entity, manager.activeClient);
  if (entityIdResult === null || entityIdResult === undefined) {
    return [];
  }
  const entityId = normalizeId(entityIdResult);

  // The caller has already paired this row with its before state, and compose never reads
  // `identity` or `origin`, so the resolved entity id stands in for the primary key.
  const event: ResolvedEvent = {
    model: modelName,
    identity: entityId,
    action: toMutationAction(action, before),
    before: before ?? undefined,
    after: entity,
    origin: { path: '', op: action },
    entityId,
    roots: aggregateRoots,
    actorContext,
    entityContext,
    aggregateContexts,
  };

  return compose(
    [event],
    {
      auditContext: context,
      config: {
        entity: () => entityConfig,
        excludeFields: excludeFields ?? [],
        redact,
        serialization,
        includeRelations,
        relationFieldNames: () => relationFieldNames,
      },
    },
    new Date(),
  );
};
