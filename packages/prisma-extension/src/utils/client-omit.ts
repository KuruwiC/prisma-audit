/**
 * The fields a client-level `omit` hides
 *
 * A client created with `new PrismaClient({ omit })` leaves those fields out of every read that
 * does not name them. The audit still reads them, records their change and masks their values, so
 * it needs to know which they are. Prisma exposes the setting through no public API: it is read
 * here, and only here, from the client's internal `_globalOmit` field, which holds the `omit`
 * option as given, keyed by the model's client property.
 *
 * When the field cannot be read, no field is known to be hidden, and the audit reads the client's
 * default shape, as for a client without `omit`. On a client that takes a query `omit`, that shape
 * is read without naming its columns, so the hidden fields are left out of the audit. On one that
 * takes none, a caller `select` is read by listing every scalar field, the hidden ones among them,
 * so every scalar field is masked instead: the changes are recorded, no value in clear.
 *
 * @module utils/client-omit
 */

import type { SchemaMetadata } from '../schema/types.js';
import { isRecord } from './is-record.js';
import { getModelAccessor } from './model-accessor.js';
import { supportsClientOmit, supportsQueryOmit } from './prisma-version.js';

/** The fields of each model a client-level `omit` hides, as the audit reads and masks them */
export interface ClientOmittedFields {
  /**
   * The fields of `modelName` the client is known to omit, which the audit's reads name so they
   * are read; none when the client's `omit` setting cannot be read
   */
  of(modelName: string): ReadonlySet<string>;
  /**
   * The fields of `modelName` masked in the stored states and changes: the fields the client
   * omits; every scalar field when the setting cannot be read on a client that takes no query `omit`
   */
  masked(modelName: string): ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

export const NO_CLIENT_OMITTED_FIELDS: ClientOmittedFields = { of: () => NONE, masked: () => NONE };

/** The client field Prisma keeps the `omit` option in, from Prisma 5.16 */
const GLOBAL_OMIT_FIELD = '_globalOmit';

const WARNING_PREFIX = `[@prisma-audit] Cannot read the client's omit setting (the Prisma client's internal ${GLOBAL_OMIT_FIELD} field)`;

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

const isScalar = (field: { readonly kind: string }): boolean => field.kind === 'scalar' || field.kind === 'enum';

/** `fieldsOf` with each model's fields computed once */
const perModel = (
  fieldsOf: (modelName: string) => ReadonlySet<string>,
): ((modelName: string) => ReadonlySet<string>) => {
  const byModel = new Map<string, ReadonlySet<string>>();
  return (modelName) => {
    let fields = byModel.get(modelName);
    if (fields === undefined) {
      fields = fieldsOf(modelName);
      byModel.set(modelName, fields);
    }
    return fields;
  };
};

const omittedFieldsOf = (globalOmit: GlobalOmit, schemaMetadata: SchemaMetadata): ClientOmittedFields => {
  const of = perModel((modelName) => {
    const entries = globalOmit[getModelAccessor(modelName)] ?? {};
    return new Set(
      schemaMetadata
        .getAllFields(modelName)
        .filter((field) => isScalar(field) && entries[field.name] === true)
        .map((field) => field.name),
    );
  });
  return { of, masked: of };
};

/**
 * The fields for a client whose `omit` setting cannot be read, with one warning stating what that
 * leaves out of or masks in the audit logs
 */
const unknownOmittedFields = (schemaMetadata: SchemaMetadata, queryOmitSupported: boolean): ClientOmittedFields => {
  if (queryOmitSupported) {
    console.warn(
      `${WARNING_PREFIX}: the fields a client-level omit hides are left out of audit logs, neither read nor recorded.`,
    );
    return NO_CLIENT_OMITTED_FIELDS;
  }
  console.warn(
    `${WARNING_PREFIX}, and the client takes no query omit (Prisma before 6.2, or a version that cannot be ` +
      "determined): a query's select is read by listing every column, the ones a client-level omit hides " +
      'among them, so every column value is masked in audit logs; the changes are still recorded.',
  );
  return {
    of: () => NONE,
    masked: perModel(
      (modelName) =>
        new Set(
          schemaMetadata
            .getAllFields(modelName)
            .filter(isScalar)
            .map((field) => field.name),
        ),
    ),
  };
};

/**
 * @param clientVersion - A client older than 5.16 has no `omit` option, so nothing is read from it
 * @returns The scalar fields each model's entry sets to `true`; when a client that may keep the
 *   option does not expose it in the expected shape, no field known, with one warning
 */
export const readClientOmittedFields = (
  client: object,
  schemaMetadata: SchemaMetadata,
  clientVersion: string | undefined,
): ClientOmittedFields => {
  if (supportsClientOmit(clientVersion) === false) {
    return NO_CLIENT_OMITTED_FIELDS;
  }
  const globalOmit = globalOmitOf(client);
  return globalOmit
    ? omittedFieldsOf(globalOmit, schemaMetadata)
    : unknownOmittedFields(schemaMetadata, supportsQueryOmit(clientVersion));
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
