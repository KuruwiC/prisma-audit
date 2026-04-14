/**
 * Audit log builder module
 *
 * Constructs AuditLogData objects from entity operations with aggregate root resolution,
 * field-level diffing, redaction, and Prisma JSONB-compatible date serialization.
 *
 * @module audit-log-builder
 */

import type {
  AggregateConfigService,
  AuditContext,
  LoggableEntity,
  ResolvedId,
  SerializationConfig,
} from '@kuruwic/prisma-audit-core';
import {
  AUDIT_ACTION,
  applyRelationConfig,
  batchEnrichAggregateContexts,
  createActorId,
  createAggregateId,
  createDiffCalculator,
  createEntityId,
  normalizeId,
  type RedactConfig,
  redactSensitiveData,
  resolveAllAggregateRoots,
  resolveBeforeAndAfterStates,
  serializeForAuditJson,
  type ValueSerializer,
} from '@kuruwic/prisma-audit-core';
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

/**
 * Resolve aggregate roots and enrich aggregate contexts for a single entity.
 *
 * Used by single-operation and nested-operation callers.
 * Batch callers should resolve roots and enrich contexts in bulk instead.
 */
export const resolveAggregateData = async (
  entity: Record<string, unknown>,
  entityConfig: LoggableEntity,
  prisma: unknown,
): Promise<ResolvedAggregateData> => {
  const aggregateRoots = await resolveAllAggregateRoots(entity, entityConfig, prisma);

  const aggregateContexts = new Map<string, unknown>();
  for (const root of aggregateRoots) {
    const cacheKey = aggregateContextKey(root.aggregateType, root.aggregateId);
    if (!aggregateContexts.has(cacheKey)) {
      const meta = {
        aggregateType: root.aggregateType,
        aggregateCategory: root.aggregateCategory,
        aggregateId: root.aggregateId,
      };
      const [enrichedContext] = await batchEnrichAggregateContexts([entity], entityConfig, prisma, meta);
      aggregateContexts.set(cacheKey, enrichedContext);
    }
  }

  return { aggregateRoots, aggregateContexts };
};

/**
 * Type guard to ensure redaction result is a record or null/undefined
 */
const isRecordOrNullish = (value: unknown): value is Record<string, unknown> | null | undefined => {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value));
};

/**
 * Apply redaction to audit log states and changes
 *
 * @remarks
 * redactSensitiveData returns unknown but preserves the structure of the input.
 * We validate the output type to ensure it matches our expectations.
 */
const applyRedactionToStates = (
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  changes: Record<string, { old: unknown; new: unknown }> | null,
  redactConfig: RedactConfig,
): [
  Record<string, unknown> | null | undefined,
  Record<string, unknown> | null | undefined,
  Record<string, { old: unknown; new: unknown }> | null,
] => {
  const redactedBeforeRaw = redactSensitiveData(beforeData, redactConfig);
  const redactedAfterRaw = redactSensitiveData(afterData, redactConfig);

  if (!isRecordOrNullish(redactedBeforeRaw) || !isRecordOrNullish(redactedAfterRaw)) {
    throw new Error('[@prisma-audit] Redaction produced unexpected type');
  }

  const redactedBefore = redactedBeforeRaw;
  const redactedAfter = redactedAfterRaw;

  let redactedChanges: Record<string, { old: unknown; new: unknown }> | null = null;
  if (changes) {
    const redactedChangesResult = redactSensitiveData(changes, redactConfig);
    if (!isRecordOrNullish(redactedChangesResult)) {
      throw new Error('[@prisma-audit] Redaction of changes produced unexpected type');
    }
    // Type assertion justified: redactSensitiveData preserves structure, validated by type guard
    redactedChanges = redactedChangesResult as Record<string, { old: unknown; new: unknown }> | null;
  }

  return [redactedBefore, redactedAfter, redactedChanges];
};

/**
 * Serialize all JSON-bound fields in AuditLogData for Prisma JSONB storage
 *
 * Centralizes serialization of all `unknown`-typed fields that end up in Prisma JSON columns.
 * This prevents BigInt/Date values in any field (states, contexts, request metadata)
 * from causing JSON.stringify errors at write time.
 *
 * Fields NOT serialized:
 * - `createdAt`: DateTime column, Prisma handles natively
 * - `actorId`/`entityId`/`aggregateId`: branded strings, already JSON-safe
 * - `*Category`/`*Type`/`action`: plain strings
 */
const serializeAuditLogData = (log: AuditLogData, customSerializers?: ValueSerializer[]): AuditLogData => ({
  ...log,
  before: serializeForAuditJson(log.before, customSerializers),
  after: serializeForAuditJson(log.after, customSerializers),
  changes: serializeForAuditJson(log.changes, customSerializers),
  actorContext: serializeForAuditJson(log.actorContext, customSerializers),
  entityContext: serializeForAuditJson(log.entityContext, customSerializers),
  aggregateContext: serializeForAuditJson(log.aggregateContext, customSerializers),
  requestContext: serializeForAuditJson(log.requestContext, customSerializers),
});

/**
 * Check if only excluded fields were changed (no meaningful changes)
 *
 * @remarks
 * Skips audit log when changes are null/empty and beforeData exists.
 * Prevents logging operations that only touch excluded fields.
 */
const shouldSkipAuditLog = (
  changes: Record<string, { old: unknown; new: unknown }> | null,
  beforeData: Record<string, unknown> | null,
): boolean => {
  if (beforeData === null) {
    return false;
  }

  return !changes || Object.keys(changes).length === 0;
};

/**
 * Build a single audit log entry for an aggregate root
 */
const buildSingleAuditLog = (
  root: { aggregateCategory: string; aggregateType: string; aggregateId: string },
  context: AuditContext,
  entityConfig: { category: string; type: string },
  entityId: string,
  actualAction: PrismaAction,
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  changes: Record<string, { old: unknown; new: unknown }> | null,
  actorContext: unknown,
  entityContext: unknown,
  aggregateContext: unknown,
): AuditLogData => {
  const requestContext = context.request || null;

  return {
    actorCategory: context.actor.category,
    actorType: context.actor.type,
    actorId: createActorId(context.actor.id),
    actorContext,

    entityCategory: entityConfig.category,
    entityType: entityConfig.type,
    entityId: createEntityId(entityId),
    entityContext,

    aggregateCategory: root.aggregateCategory,
    aggregateType: root.aggregateType,
    aggregateId: createAggregateId(root.aggregateId),
    aggregateContext,

    action: actualAction,
    before: beforeData,
    after: afterData,
    changes,

    requestContext,
    createdAt: new Date(),
  };
};

/**
 * Build audit log data for an entity
 *
 * @remarks
 * Processing flow:
 * 1. Resolve aggregate roots and entity ID
 * 2. Determine actual action and before/after states
 * 3. Calculate field-level changes (pre-redaction)
 * 4. Apply redaction and relation config
 * 5. Build audit log for each aggregate root using pre-resolved aggregate contexts
 *
 * Returns empty array if:
 * - Entity config not found
 * - No aggregate roots found
 * - ID resolution fails
 * - Only excluded fields changed (updates only)
 */
export const buildAuditLog = async (
  entity: Record<string, unknown>,
  action: PrismaAction,
  context: AuditContext,
  modelName: string,
  manager: PrismaClientManager,
  actorContext: unknown,
  entityContext: unknown,
  before: Record<string, unknown> | null | undefined,
  aggregateConfig: AggregateConfigService,
  excludeFields: string[] | undefined,
  redact: RedactConfig | undefined,
  aggregateData: ResolvedAggregateData,
  includeRelations?: boolean,
  serialization?: SerializationConfig,
  relationFieldNames?: Set<string>,
): Promise<AuditLogData[]> => {
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

  const [actualAction, beforeDataUnredacted, afterDataUnredacted] = resolveBeforeAndAfterStates(action, entity, before);

  const mergedExcludeFields = entityConfig.excludeFields ?? excludeFields;
  const diffCalculator = createDiffCalculator(new Set(mergedExcludeFields));
  const shouldCalculateChanges = actualAction === AUDIT_ACTION.UPDATE;
  const changesUnredacted = shouldCalculateChanges ? diffCalculator(beforeDataUnredacted, afterDataUnredacted) : null;

  if (shouldCalculateChanges && shouldSkipAuditLog(changesUnredacted, beforeDataUnredacted)) {
    return [];
  }

  let beforeData: Record<string, unknown> | null | undefined = beforeDataUnredacted;
  let afterData: Record<string, unknown> | null | undefined = afterDataUnredacted;
  let changes: Record<string, { old: unknown; new: unknown }> | null = changesUnredacted;

  if (redact) {
    [beforeData, afterData, changes] = applyRedactionToStates(beforeData, afterData, changes, redact);
  }

  const shouldIncludeRelations = entityConfig.includeRelations ?? includeRelations ?? false;
  [beforeData, afterData] = applyRelationConfig(beforeData, afterData, shouldIncludeRelations, relationFieldNames);

  const auditLogs: AuditLogData[] = [];
  const customSerializers = serialization?.customSerializers;

  for (const root of aggregateRoots) {
    const aggregateContextForRoot =
      aggregateContexts.get(aggregateContextKey(root.aggregateType, root.aggregateId)) ?? null;

    const rawLog = buildSingleAuditLog(
      root,
      context,
      entityConfig,
      entityId,
      actualAction,
      beforeData,
      afterData,
      changes,
      actorContext,
      entityContext,
      aggregateContextForRoot,
    );

    auditLogs.push(serializeAuditLogData(rawLog, customSerializers));
  }

  return auditLogs;
};
