/**
 * The fields a client-level `omit` hides
 *
 * A client created with `new PrismaClient({ omit })` leaves those fields out of every read that
 * does not name them. The audit still reads them, records their change and masks their values, so
 * it needs to know which they are. Prisma exposes the setting through no public API: it is read
 * here, and only here, from the client's internal `_globalOmit` field, which holds the `omit`
 * option as given, keyed by the model's client property. When the field cannot be read, no field
 * is known to be hidden: the audit reads the client's default shape, as for a client without
 * `omit`, and the fields it hides are not audited.
 *
 * @module utils/client-omit
 */

import type { SchemaMetadata } from '../schema/types.js';
import { isRecord } from './is-record.js';
import { getModelAccessor } from './model-accessor.js';
import { supportsClientOmit } from './prisma-version.js';

/** The fields of each model the client omits from every read that does not name them */
export interface ClientOmittedFields {
  of(modelName: string): ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

export const NO_CLIENT_OMITTED_FIELDS: ClientOmittedFields = { of: () => NONE };

/** The client field Prisma keeps the `omit` option in, from Prisma 5.16 */
const GLOBAL_OMIT_FIELD = '_globalOmit';

type GlobalOmit = Record<string, Record<string, boolean>>;

const isGlobalOmit = (value: unknown): value is GlobalOmit =>
  isRecord(value) &&
  Object.values(value).every(
    (fields) => isRecord(fields) && Object.values(fields).every((omitted) => typeof omitted === 'boolean'),
  );

/** The `omit` option of `client`, `{}` for a client created without it; undefined when it cannot be read */
const globalOmitOf = (client: object): GlobalOmit | undefined => {
  if (!(GLOBAL_OMIT_FIELD in client)) {
    return undefined;
  }
  const value: unknown = Reflect.get(client, GLOBAL_OMIT_FIELD);
  if (value === undefined) {
    return {};
  }
  return isGlobalOmit(value) ? value : undefined;
};

/**
 * @param clientVersion - A client older than 5.16 has no `omit` option, so nothing is read from it
 * @returns The scalar fields each model's entry sets to `true`; no field, with one warning, when a
 *   client that should keep the option does not expose it in the expected shape
 */
export const readClientOmittedFields = (
  client: object,
  schemaMetadata: SchemaMetadata,
  clientVersion: string | undefined,
): ClientOmittedFields => {
  if (supportsClientOmit(clientVersion) !== true) {
    return NO_CLIENT_OMITTED_FIELDS;
  }
  const globalOmit = globalOmitOf(client);
  if (!globalOmit) {
    console.warn(
      `[@prisma-audit] Cannot read the client's omit setting (the Prisma client's internal ${GLOBAL_OMIT_FIELD} ` +
        'field): fields a client-level omit hides are not audited.',
    );
    return NO_CLIENT_OMITTED_FIELDS;
  }

  const byModel = new Map<string, ReadonlySet<string>>();
  return {
    of: (modelName) => {
      let fields = byModel.get(modelName);
      if (fields === undefined) {
        const entries = globalOmit[getModelAccessor(modelName)] ?? {};
        fields = new Set(
          schemaMetadata
            .getAllFields(modelName)
            .filter((field) => (field.kind === 'scalar' || field.kind === 'enum') && entries[field.name] === true)
            .map((field) => field.name),
        );
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
 * the audit reads holds the fields the client omits; `delegate` itself when there is none.
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
