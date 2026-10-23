/** Record composition: resolved mutation events to audit records */

import { createActorId, createAggregateId, createEntityId } from '../domain/branded-types.js';
import { type AuditRecord, aggregateRootKey, type ResolvedEvent } from '../domain/mutation-event.js';
import type { AuditContext } from '../types.js';
import { createDiffCalculator, type DiffResult } from '../utils/diff-calculator.js';
import { maskChanges, maskColumns, redactSensitiveData } from '../utils/redaction.js';
import { removeRelations } from '../utils/remove-relations.js';
import { serializeForAuditJson, type ValueSerializer } from '../utils/serialization.js';

export interface EntityComposeConfig {
  readonly category: string;
  readonly type: string;
  /** Fields excluded from change tracking; replaces the global list when present (`[]` clears it). */
  readonly diffExcludeFields?: readonly string[];
  /**
   * Fields the client leaves out of its default reads that the adapter reads anyway: masked in the
   * stored states and changes after the diff, so a change to one is recorded without its values.
   */
  readonly recordOmittedFields?: readonly string[];
}

export interface ComposeConfig<TModelName extends string = string> {
  /** Entity configuration of a written model, or undefined when the model is not audited. */
  readonly entity: (model: TModelName) => EntityComposeConfig | undefined;
  /** Fields excluded from change tracking for every entity without its own list. */
  readonly diffExcludeFields: readonly string[];
  /** Fields masked in every stored state and change set, on top of the built-in sensitive fields. */
  readonly redactFields: readonly string[];
  /** Serializers applied before the built-in conversions (BigInt, Date) to every stored value. */
  readonly serializers?: readonly ValueSerializer[];
  /**
   * The keys of a row of a model that are not its columns: its relation fields and any aggregate
   * the ORM returns with the row (such as `_count`). Neither compared nor stored; undefined strips
   * nothing.
   */
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

/** The states as stored: JSON-safe plain data, the output of the serializer */
interface StoredStates {
  readonly before: unknown;
  readonly after: unknown;
  readonly changes: unknown;
}

const isRecordOrNullish = (value: unknown): value is Record<string, unknown> | null | undefined => {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value));
};

/**
 * Serialize the states with the custom serializers first, so a class instance among the column
 * values reaches the redactor as the plain data stored for it.
 */
const serializeStates = (states: RecordStates, serializers?: readonly ValueSerializer[]): StoredStates => ({
  before: serializeForAuditJson(states.before, serializers),
  after: serializeForAuditJson(states.after, serializers),
  changes: serializeForAuditJson(states.changes, serializers),
});

/**
 * Redact the stored states. `redactSensitiveData` preserves the structure of its input; the guards
 * turn a state that is not a record, which the redactor cannot match by key, into an error instead
 * of storing it.
 */
const redactStates = (states: StoredStates, redactFields: readonly string[]): StoredStates => {
  const before = redactSensitiveData(states.before, redactFields);
  const after = redactSensitiveData(states.after, redactFields);

  if (!isRecordOrNullish(before) || !isRecordOrNullish(after)) {
    throw new Error('[db-audit-core] Redaction produced unexpected type');
  }

  let changes: unknown = null;
  if (states.changes) {
    changes = redactSensitiveData(states.changes, redactFields);
    if (!isRecordOrNullish(changes)) {
      throw new Error('[db-audit-core] Redaction of changes produced unexpected type');
    }
  }

  return { before: before ?? null, after: after ?? null, changes };
};

/** A copy of the stored states that shares no object with them, for one more record of the same event */
const copyStates = (states: StoredStates): StoredStates => structuredClone(states);

const maskStates = (states: RecordStates, fields: ReadonlySet<string>): RecordStates => ({
  before: states.before && maskColumns(states.before, fields),
  after: states.after && maskColumns(states.after, fields),
  changes: states.changes && maskChanges(states.changes, fields),
});

/** An update whose diff is empty against an existing before state changed only excluded fields. */
const changedOnlyExcludedFields = (changes: DiffResult, before: State): boolean => {
  if (before === null) {
    return false;
  }

  return !changes || Object.keys(changes).length === 0;
};

/**
 * Serialize the contexts and request metadata so BigInt and Date values in them never reach the
 * database driver; the states arrive serialized. `createdAt` is a DateTime column and the ids and
 * categories are plain strings, so they pass through.
 */
const serializeContexts = (record: AuditRecord, serializers?: readonly ValueSerializer[]): AuditRecord => ({
  ...record,
  actorContext: serializeForAuditJson(record.actorContext, serializers),
  entityContext: serializeForAuditJson(record.entityContext, serializers),
  aggregateContext: serializeForAuditJson(record.aggregateContext, serializers),
  requestContext: serializeForAuditJson(record.requestContext, serializers),
});

const resolveStates = <TModelName extends string>(
  event: ResolvedEvent<TModelName>,
  entity: EntityComposeConfig,
  config: ComposeConfig<TModelName>,
): RecordStates | undefined => {
  const before = event.action !== 'create' && event.before.kind === 'captured' ? event.before.row : null;
  const after = event.action === 'delete' ? null : (event.after ?? null);

  const relationFieldNames = config.relationFieldNames(event.model);
  const columnsOf = (state: State): State => state && removeRelations(state, relationFieldNames);
  const beforeColumns = columnsOf(before);
  const afterColumns = columnsOf(after);

  const isUpdate = event.action === 'update';
  const diffExcludeFields = entity.diffExcludeFields ?? config.diffExcludeFields;
  const changes = isUpdate ? createDiffCalculator(new Set(diffExcludeFields))(beforeColumns, afterColumns) : null;

  if (isUpdate && changedOnlyExcludedFields(changes, before)) {
    return undefined;
  }

  const maskedFields = new Set(entity.recordOmittedFields);
  const columns = { before: beforeColumns, after: afterColumns, changes };
  return maskedFields.size > 0 ? maskStates(columns, maskedFields) : columns;
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

  const serialized = serializeStates(states, config.serializers);
  const stored = redactStates(serialized, config.redactFields);
  const requestContext = auditContext.request || null;

  // Each root's record holds its own states, so a writer that changes one record leaves the others as composed
  return event.roots.map((root, index) => {
    const recordStates = index === 0 ? stored : copyStates(stored);
    return serializeContexts(
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
        aggregateContext: event.aggregateContexts.get(aggregateRootKey(root)) ?? null,

        action: event.action,
        before: recordStates.before,
        after: recordStates.after,
        changes: recordStates.changes,
        beforeUnavailable: event.action !== 'create' && event.before.kind === 'unavailable',

        requestContext,
        createdAt: now,
      },
      config.serializers,
    );
  });
};

/**
 * Compose audit records from resolved events, in event order, one record per aggregate root
 *
 * An event yields no records when its model has no entity configuration, when no aggregate
 * root resolved, or when an update changed only excluded fields of an existing before state.
 *
 * @throws {IdValidationError} When the actor id, the resolved entity id or an aggregate id is empty
 * @throws {Error} When a serialized state or change set is not a record
 */
export const compose = <TModelName extends string>(
  events: readonly ResolvedEvent<TModelName>[],
  ambient: ComposeAmbient<TModelName>,
  now: Date,
): AuditRecord[] => events.flatMap((event) => composeEvent(event, ambient, now));
