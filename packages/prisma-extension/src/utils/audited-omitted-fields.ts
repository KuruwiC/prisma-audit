/**
 * The omitted fields an entity records
 *
 * A client created with `new PrismaClient({ omit })` leaves the fields it hides out of every read
 * that does not name them, and the audit records the rows in that default shape. An entity lists
 * the hidden fields to record anyway in `recordOmittedFields`; those, less the fields the entity's
 * `diffExcludeFields` names, are read in the audit's own queries: its whole-row reads, before and
 * after the write, through {@link withOmittedFieldsInFinds}, and a read by row key after the
 * write of the written rows it did not read itself (`pipeline/omitted-fields-after-write.ts`). The
 * caller's query is never widened with them. The audit's batch reads, which tell rows apart by their
 * row key, and the top-level read before the write, which identifies a row the write returns without
 * its key, also read the key fields a client omit hides ({@link withRowKeyFields}).
 *
 * @module utils/audited-omitted-fields
 */

import type { SchemaMetadata } from '../schema/types.js';
import { rowKeyFieldsOf } from './id-generation.js';
import { isRecord } from './is-record.js';

/** The omitted fields of each model the audit reads */
export interface AuditedOmittedFields {
  of(modelName: string): ReadonlySet<string>;
}

interface OmittedFieldsEntity {
  readonly recordOmittedFields?: readonly string[];
  readonly diffExcludeFields?: readonly string[];
}

const NONE: ReadonlySet<string> = new Set();

export const NO_AUDITED_OMITTED_FIELDS: AuditedOmittedFields = { of: () => NONE };

/**
 * @param diffExcludeFields - The global `diffExcludeFields`, which applies to an entity without its own list
 */
export const createAuditedOmittedFields = (
  entityOf: (modelName: string) => OmittedFieldsEntity | undefined,
  diffExcludeFields: readonly string[],
): AuditedOmittedFields => {
  const byModel = new Map<string, ReadonlySet<string>>();
  return {
    of: (modelName) => {
      let fields = byModel.get(modelName);
      if (fields === undefined) {
        const entity = entityOf(modelName);
        const excluded = new Set(entity?.diffExcludeFields ?? diffExcludeFields);
        const listed = (entity?.recordOmittedFields ?? []).filter((field) => !excluded.has(field));
        fields = listed.length > 0 ? new Set(listed) : NONE;
        byModel.set(modelName, fields);
      }
      return fields;
    },
  };
};

/**
 * `auditedOmittedFields` with each model's row key (`rowKeyFieldsOf`) added, so a read that names
 * rows by their key reads it whatever a client-level omit hides. A client that takes no query omit
 * (before Prisma 6.2) hides no field, and a model with no row key has none to add: both get
 * `auditedOmittedFields` as it is.
 */
export const withRowKeyFields = (
  auditedOmittedFields: AuditedOmittedFields,
  schemaMetadata: SchemaMetadata,
  queryOmitSupported: boolean,
): AuditedOmittedFields => {
  if (!queryOmitSupported) {
    return auditedOmittedFields;
  }
  const byModel = new Map<string, ReadonlySet<string>>();
  return {
    of: (modelName) => {
      let fields = byModel.get(modelName);
      if (fields === undefined) {
        const audited = auditedOmittedFields.of(modelName);
        const rowKey = rowKeyFieldsOf(schemaMetadata, modelName) ?? [];
        fields = rowKey.length > 0 ? new Set([...audited, ...rowKey]) : audited;
        byModel.set(modelName, fields);
      }
      return fields;
    },
  };
};

/** The query `omit` that reads `fields` although the client omits them; undefined for no field */
export const omitFalseEntries = (fields: ReadonlySet<string>): Record<string, false> | undefined =>
  fields.size > 0 ? Object.fromEntries(Array.from(fields, (field) => [field, false])) : undefined;

const FIND_OPERATIONS: ReadonlySet<PropertyKey> = new Set(['findUnique', 'findFirst', 'findMany']);

const withOmitEntries = (args: unknown, omit: Record<string, false>): unknown =>
  isRecord(args) && args.select === undefined
    ? { ...args, omit: { ...omit, ...(isRecord(args.omit) ? args.omit : {}) } }
    : args;

/**
 * `delegate` with its finds reading `fields` too when their args name no `select`, so a whole row
 * the audit reads holds the omitted fields its entity records; `delegate` itself when there is none.
 */
export const withOmittedFieldsInFinds = <TDelegate extends object>(
  delegate: TDelegate,
  fields: ReadonlySet<string>,
): TDelegate => {
  const omit = omitFalseEntries(fields);
  if (!omit) {
    return delegate;
  }
  return new Proxy(delegate, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (!FIND_OPERATIONS.has(key) || typeof value !== 'function') {
        return value;
      }
      return (args: unknown) => Reflect.apply(value, target, [withOmitEntries(args, omit)]);
    },
  });
};
