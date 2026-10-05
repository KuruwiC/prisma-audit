/**
 * The omitted fields an entity audits
 *
 * A client created with `new PrismaClient({ omit })` leaves the fields it hides out of every read
 * that does not name them, and the audit records the rows in that default shape. An entity lists
 * the hidden fields to audit anyway in `auditOmittedFields`; those, less the fields the entity's
 * `excludeFields` names, are read in the audit's own queries: its whole-row reads, before and
 * after the write, through {@link withOmittedFieldsInFinds}, and a read by primary key after the
 * write of the written rows it did not read itself (`pipeline/omitted-fields-after-write.ts`). The
 * caller's query is never widened with them.
 *
 * @module utils/audited-omitted-fields
 */

import { isRecord } from './is-record.js';

/** The omitted fields of each model the audit reads */
export interface AuditedOmittedFields {
  of(modelName: string): ReadonlySet<string>;
}

interface OmittedFieldsEntity {
  readonly auditOmittedFields?: readonly string[];
  readonly excludeFields?: readonly string[];
}

const NONE: ReadonlySet<string> = new Set();

export const NO_AUDITED_OMITTED_FIELDS: AuditedOmittedFields = { of: () => NONE };

/**
 * @param excludeFields - The global `excludeFields`, which applies to an entity without its own list
 */
export const createAuditedOmittedFields = (
  entityOf: (modelName: string) => OmittedFieldsEntity | undefined,
  excludeFields: readonly string[],
): AuditedOmittedFields => {
  const byModel = new Map<string, ReadonlySet<string>>();
  return {
    of: (modelName) => {
      let fields = byModel.get(modelName);
      if (fields === undefined) {
        const entity = entityOf(modelName);
        const excluded = new Set(entity?.excludeFields ?? excludeFields);
        const listed = (entity?.auditOmittedFields ?? []).filter((field) => !excluded.has(field));
        fields = listed.length > 0 ? new Set(listed) : NONE;
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
 * the audit reads holds the omitted fields its entity audits; `delegate` itself when there is none.
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
