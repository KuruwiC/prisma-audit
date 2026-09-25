/** Record composition: resolved mutation events to audit records */

import type { SerializationConfig } from '../config.types.js';
import { createActorId, createAggregateId, createEntityId } from '../domain/branded-types.js';
import type { AuditRecord, ResolvedEvent } from '../domain/mutation-event.js';
import { applyRelationConfig } from '../state-resolution/apply-relation-config.js';
import type { AuditContext } from '../types.js';
import { createDiffCalculator, type DiffResult } from '../utils/diff-calculator.js';
import { type RedactConfig, redactSensitiveData } from '../utils/redaction.js';
import { serializeForAuditJson, type ValueSerializer } from '../utils/serialization.js';

export interface EntityComposeConfig {
  readonly category: string;
  readonly type: string;
  /** Fields excluded from change tracking; overrides the global list when present. */
  readonly excludeFields?: readonly string[];
  /** Whether relation objects stay in the stored states; overrides the global setting when present. */
  readonly includeRelations?: boolean;
}

export interface ComposeConfig<TModelName extends string = string> {
  /** Entity configuration of a written model, or undefined when the model is not audited. */
  readonly entity: (model: TModelName) => EntityComposeConfig | undefined;
  /** Fields excluded from change tracking for every entity without its own list. */
  readonly excludeFields: readonly string[];
  readonly redact?: RedactConfig;
  readonly serialization?: SerializationConfig;
  readonly includeRelations?: boolean;
  /** Relation field names of a model, as the adapter derives them from its schema; undefined strips nothing. */
  readonly relationFieldNames: (model: TModelName) => ReadonlySet<string> | undefined;
}

export interface ComposeAmbient<TModelName extends string = string> {
  readonly auditContext: AuditContext;
  readonly config: ComposeConfig<TModelName>;
}

type State = Record<string, unknown> | null;

interface RecordStates {
  readonly before: State;
  readonly after: State;
  readonly changes: DiffResult;
}

const isRecordOrNullish = (value: unknown): value is Record<string, unknown> | null | undefined => {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value));
};

/**
 * `redactSensitiveData` returns unknown but preserves the structure of its input; the guards
 * turn a structure it did not preserve into an error instead of storing it.
 */
const redactStates = (states: RecordStates, redactConfig: RedactConfig): RecordStates => {
  const before = redactSensitiveData(states.before, redactConfig);
  const after = redactSensitiveData(states.after, redactConfig);

  if (!isRecordOrNullish(before) || !isRecordOrNullish(after)) {
    throw new Error('[db-audit-core] Redaction produced unexpected type');
  }

  let changes: DiffResult = null;
  if (states.changes) {
    const redactedChanges = redactSensitiveData(states.changes, redactConfig);
    if (!isRecordOrNullish(redactedChanges)) {
      throw new Error('[db-audit-core] Redaction of changes produced unexpected type');
    }
    changes = redactedChanges as DiffResult;
  }

  return { before: before ?? null, after: after ?? null, changes };
};

/** An update whose diff is empty against an existing before state changed only excluded fields. */
const changedOnlyExcludedFields = (changes: DiffResult, before: State): boolean => {
  if (before === null) {
    return false;
  }

  return !changes || Object.keys(changes).length === 0;
};

/**
 * Serialize every JSON-bound field so BigInt and Date values in states, contexts and request
 * metadata never reach the database driver. `createdAt` is a DateTime column and the ids and
 * categories are plain strings, so they pass through.
 */
const serializeRecord = (record: AuditRecord, customSerializers?: ValueSerializer[]): AuditRecord => ({
  ...record,
  before: serializeForAuditJson(record.before, customSerializers),
  after: serializeForAuditJson(record.after, customSerializers),
  changes: serializeForAuditJson(record.changes, customSerializers),
  actorContext: serializeForAuditJson(record.actorContext, customSerializers),
  entityContext: serializeForAuditJson(record.entityContext, customSerializers),
  aggregateContext: serializeForAuditJson(record.aggregateContext, customSerializers),
  requestContext: serializeForAuditJson(record.requestContext, customSerializers),
});

const resolveStates = <TModelName extends string>(
  event: ResolvedEvent<TModelName>,
  entity: EntityComposeConfig,
  config: ComposeConfig<TModelName>,
): RecordStates | undefined => {
  const before = event.action !== 'create' && event.before.kind === 'captured' ? event.before.row : null;
  const after = event.action === 'delete' ? null : (event.after ?? null);

  const isUpdate = event.action === 'update';
  const excludeFields = entity.excludeFields ?? config.excludeFields;
  const changes = isUpdate ? createDiffCalculator(new Set(excludeFields))(before, after) : null;

  if (isUpdate && changedOnlyExcludedFields(changes, before)) {
    return undefined;
  }

  const states = config.redact ? redactStates({ before, after, changes }, config.redact) : { before, after, changes };

  const includeRelations = entity.includeRelations ?? config.includeRelations ?? false;
  const [strippedBefore, strippedAfter] = applyRelationConfig(
    states.before,
    states.after,
    includeRelations,
    config.relationFieldNames(event.model),
  );

  return { before: strippedBefore, after: strippedAfter, changes: states.changes };
};

const composeEvent = <TModelName extends string>(
  event: ResolvedEvent<TModelName>,
  ambient: ComposeAmbient<TModelName>,
  now: Date,
): AuditRecord[] => {
  const { auditContext, config } = ambient;

  const entity = config.entity(event.model);
  if (!entity || event.roots.length === 0) {
    return [];
  }

  const states = resolveStates(event, entity, config);
  if (!states) {
    return [];
  }

  const requestContext = auditContext.request || null;
  const customSerializers = config.serialization?.customSerializers;

  return event.roots.map((root) =>
    serializeRecord(
      {
        actorCategory: auditContext.actor.category,
        actorType: auditContext.actor.type,
        actorId: createActorId(auditContext.actor.id),
        actorContext: event.actorContext,

        entityCategory: entity.category,
        entityType: entity.type,
        entityId: createEntityId(event.entityId),
        entityContext: event.entityContext,

        aggregateCategory: root.aggregateCategory,
        aggregateType: root.aggregateType,
        aggregateId: createAggregateId(root.aggregateId),
        aggregateContext: event.aggregateContexts.get(`${root.aggregateType}:${root.aggregateId}`) ?? null,

        action: event.action,
        before: states.before,
        after: states.after,
        changes: states.changes,
        beforeUnavailable: event.action !== 'create' && event.before.kind === 'unavailable',

        requestContext,
        createdAt: now,
      },
      customSerializers,
    ),
  );
};

/**
 * Compose audit records from resolved events, in event order, one record per aggregate root
 *
 * An event yields no records when its model has no entity configuration, when no aggregate
 * root resolved, or when an update changed only excluded fields of an existing before state.
 *
 * @throws {IdValidationError} When the actor id, the resolved entity id or an aggregate id is empty
 * @throws {Error} When redaction does not preserve the structure of a state
 */
export const compose = <TModelName extends string>(
  events: readonly ResolvedEvent<TModelName>[],
  ambient: ComposeAmbient<TModelName>,
  now: Date,
): AuditRecord[] => events.flatMap((event) => composeEvent(event, ambient, now));
