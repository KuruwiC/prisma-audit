/**
 * ID Generation and Primary-Key Utilities
 *
 * Provides client-side ID generation for `createMany` data, so audit logs can record
 * the IDs of rows the operation does not return, and the primary-key helpers that pair
 * before and after states, serialize a row's entity identity, and read rows by primary key.
 *
 * Generated IDs must match the format the schema declares — Prisma itself
 * generates cuid v1 for `cuid()` and UUID v7 for `uuid(7)`, so injecting a
 * different format would silently break downstream format validation.
 * Prisma exposes no public API for its generators (they live in the Rust
 * query engine, or as non-exported bundles in the JS client engine runtime),
 * so we depend on the same reference packages Prisma bundles:
 * `uuid` (v4/v7), cuid v1, and `@paralleldrive/cuid2`.
 *
 * **Supported generators:**
 * - `cuid()` / `cuid(1)`: CUID v1
 * - `cuid(2)` / `cuid2()`: CUID v2
 * - `uuid()` / `uuid(4)`: UUID v4
 * - `uuid(7)`: UUID v7
 *
 * **Unsupported (database-generated):**
 * - `autoincrement()`: Requires database INSERT
 * - `dbgenerated()`: Requires database trigger/function
 *
 * @module utils/id-generation
 */

import cuidV1 from '@bugsnag/cuid';
import { createId } from '@paralleldrive/cuid2';
import { v4 as uuidV4, v7 as uuidV7 } from 'uuid';
import { getPrimaryKeyConstraint } from '../grammar/nested-operations.js';
import type { SchemaMetadata, UniqueConstraint } from '../schema/types.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from './identity-key.js';
import { createSchemaMetadataFromDMMF, type PrismaWithDMMF } from './schema-metadata.js';

export type IdGenerator = () => string;

/**
 * Resolves a generator for a default expression's arguments.
 * Returns undefined when the arguments are not supported, so callers
 * surface an explicit error instead of injecting a wrong-format ID.
 */
export type IdGeneratorFactory = (args: readonly unknown[]) => IdGenerator | undefined;

/**
 * Supported ID generation strategies, keyed by default-expression function name.
 *
 * Each factory receives the expression's arguments (e.g. `[7]` for `uuid(7)`)
 * and returns undefined for unsupported versions — never a fallback generator.
 */
export const ID_GENERATOR_FACTORIES: Record<string, IdGeneratorFactory> = {
  cuid: (args) => {
    const version = args.length === 0 ? 1 : Number(args[0]);
    if (version === 1) return () => cuidV1();
    if (version === 2) return () => createId();
    return undefined;
  },
  cuid2: (args) => (args.length === 0 ? () => createId() : undefined),
  uuid: (args) => {
    const version = args.length === 0 ? 4 : Number(args[0]);
    if (version === 4) return () => uuidV4();
    if (version === 7) return () => uuidV7();
    return undefined;
  },
};

const resolveIdGenerator = (name: string, args: readonly unknown[]): IdGenerator | undefined =>
  ID_GENERATOR_FACTORIES[name.toLowerCase()]?.(args);

/**
 * Get ID generator for a given default expression
 *
 * @example
 * ```typescript
 * const generator = getIdGenerator('uuid(7)');
 * if (generator) {
 *   const id = generator();
 * }
 * ```
 */
export const getIdGenerator = (defaultExpr: string): IdGenerator | undefined => {
  // Inner parens (e.g. dbgenerated("uuid_generate_v4()")) intentionally don't match
  const match = defaultExpr.match(/^(\w+)\(([^()]*)\)$/);
  if (!match || !match[1]) {
    return undefined;
  }

  const args =
    match[2]?.trim() === ''
      ? []
      : (match[2] as string).split(',').map((token) => {
          const trimmed = token.trim();
          return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
        });

  return resolveIdGenerator(match[1], args);
};

export interface IdFieldInfo {
  name: string;
  hasDefault: boolean;
  generator?: IdGenerator;
  defaultExpr?: string;
}

export const getIdFieldInfo = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  idKey = 'id',
): IdFieldInfo | undefined => {
  try {
    const field = schemaMetadata.getFieldMetadata(modelName, idKey);
    if (!field) {
      return undefined;
    }

    const info: IdFieldInfo = {
      name: idKey,
      hasDefault: field.hasDefaultValue,
    };

    if (field.default) {
      const defaultValue = field.default;

      if (
        typeof defaultValue === 'object' &&
        defaultValue !== null &&
        'name' in defaultValue &&
        typeof defaultValue.name === 'string'
      ) {
        // DMMF object route: preserve args (e.g. { name: 'uuid', args: [7] })
        const args = 'args' in defaultValue && Array.isArray(defaultValue.args) ? defaultValue.args : [];
        info.defaultExpr = `${defaultValue.name}(${args.join(', ')})`;
        info.generator = resolveIdGenerator(defaultValue.name, args);
      } else if (typeof defaultValue === 'string') {
        info.defaultExpr = defaultValue;
        info.generator = getIdGenerator(defaultValue);
      }
    }

    return info;
  } catch {
    return undefined;
  }
};

/**
 * Generate missing IDs for entities in createMany data
 *
 * @throws Error if ID generation is required but not possible
 *
 * @example
 * ```typescript
 * const dataWithIds = ensureIds(schemaMetadata, 'User', [
 *   { email: 'user1@example.com' },
 *   { email: 'user2@example.com' },
 * ]);
 * ```
 */
export const ensureIds = <T extends Record<string, unknown>>(
  schemaMetadata: SchemaMetadata,
  modelName: string,
  entities: T[],
  idKey = 'id',
): T[] => {
  if (entities.length === 0) {
    return entities;
  }

  const missingIds = entities.filter((entity) => entity[idKey] === undefined);
  if (missingIds.length === 0) {
    return entities;
  }

  const idFieldInfo = getIdFieldInfo(schemaMetadata, modelName, idKey);

  if (!idFieldInfo?.hasDefault) {
    throw new Error(
      `[@prisma-audit] createMany requires pre-generated IDs for model "${modelName}". ` +
        `Field "${idKey}" has no default directive. ` +
        `Please provide IDs explicitly in your data, or add a default value (e.g., @default(cuid())) to your schema.`,
    );
  }

  if (!idFieldInfo.generator) {
    throw new Error(
      `[@prisma-audit] createMany requires pre-generated IDs for model "${modelName}". ` +
        `Field "${idKey}" has unsupported default: ${idFieldInfo.defaultExpr}. ` +
        `Supported defaults: cuid(), cuid(2), uuid(), uuid(4), uuid(7). ` +
        `For database-generated IDs like autoincrement() or dbgenerated(), ` +
        `audit logging with createMany is not supported. Use createManyAndReturn or individual create() calls instead.`,
    );
  }

  return entities.map((entity) => {
    if (entity[idKey] !== undefined) {
      return entity;
    }

    return {
      ...entity,
      [idKey]: idFieldInfo.generator?.(),
    };
  });
};

const PK_CHUNK_SIZE = 1000;

/**
 * Get a model's primary key from DMMF, as derived by `getPrimaryKeyConstraint`
 * (`@@id` with its declared name → `@id` field).
 *
 * @throws Error if DMMF is unavailable, the model is unknown, or the model has no primary key
 */
export const getPrimaryKeyConstraintOrThrow = (Prisma: PrismaWithDMMF, modelName: string): UniqueConstraint => {
  const models = Prisma.dmmf?.datamodel?.models;
  if (!models) {
    throw new Error(`[@prisma-audit] DMMF not available, cannot determine primary key for ${modelName}`);
  }

  if (!models.some((m) => m.name === modelName)) {
    throw new Error(`[@prisma-audit] Model "${modelName}" not found in DMMF`);
  }

  const primaryKey = getPrimaryKeyConstraint(createSchemaMetadataFromDMMF(Prisma), modelName);
  if (primaryKey) {
    return primaryKey;
  }

  throw new Error(
    `[@prisma-audit] Model "${modelName}" has no primary key. ` +
      'Batch audit operations require a primary key for before/after state matching.',
  );
};

/** Fields of `getPrimaryKeyConstraintOrThrow`; throws if the model has no primary key. */
export const getPrimaryKeyFields = (Prisma: PrismaWithDMMF, modelName: string): string[] =>
  getPrimaryKeyConstraintOrThrow(Prisma, modelName).fields;

/**
 * Extract the entity identity of `record` from its primary-key fields: the single key's value as
 * a string, or the JSON array of a composite key's values (BigInt values as strings), which keeps
 * `["a:b", "c"]` and `["a", "b:c"]` apart. `UNRESOLVED_ENTITY_ID` when any field is absent or null.
 */
export const extractEntityIdentity = (
  record: Record<string, unknown>,
  pkFields: readonly string[],
): EntityIdentityKey => {
  const allPresent = pkFields.every((f) => f in record && record[f] != null);
  if (!allPresent) return UNRESOLVED_ENTITY_ID;

  if (pkFields.length === 1) return String(record[pkFields[0] as string]);

  return JSON.stringify(
    pkFields.map((f) => {
      const v = record[f];
      return typeof v === 'bigint' ? v.toString() : v;
    }),
  );
};

/** The fields `pkFields` of `row`, as a key or a filter; a field the row lacks reads `undefined` */
export const primaryKeyOf = (row: Record<string, unknown>, pkFields: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(pkFields.map((field) => [field, row[field]]));

export const buildEntityMap = (
  entities: ReadonlyArray<Record<string, unknown>>,
  pkFields: string[],
): Map<EntityIdentityKey, Record<string, unknown>> => {
  const map = new Map<EntityIdentityKey, Record<string, unknown>>();
  for (const entity of entities) {
    map.set(extractEntityIdentity(entity, pkFields), entity);
  }
  return map;
};

/**
 * Build a Prisma WHERE clause to re-fetch entities by their primary keys.
 *
 * - Single PK: `{ id: { in: [...] } }`
 * - Composite PK: `{ OR: [{ pk1: v1, pk2: v2 }, ...] }`
 *
 * Returns null for empty entity lists to signal callers to skip the query.
 */
const buildPKWhereClause = (
  pkFields: string[],
  entities: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> | null => {
  if (entities.length === 0) {
    return null;
  }

  if (pkFields.length === 1) {
    const field = pkFields[0] as string;
    return { [field]: { in: entities.map((e) => e[field]) } };
  }

  // Composite PK: one OR branch per entity; `findManyByPKs` chunks the list so the query stays bounded
  const conditions = entities.map((entity) => {
    const condition: Record<string, unknown> = {};
    for (const field of pkFields) {
      condition[field] = entity[field];
    }
    return condition;
  });

  return { OR: conditions };
};

type FindManyDelegate = {
  findMany: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown>[]>;
};

/**
 * Fetch entities by primary keys in parallel batches of PK_CHUNK_SIZE, so that a single query
 * never exceeds database parameter limits.
 */
export const findManyByPKs = async (
  delegate: FindManyDelegate,
  pkFields: string[],
  entities: ReadonlyArray<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> => {
  if (entities.length === 0) return [];

  const chunks: ReadonlyArray<Record<string, unknown>>[] = [];
  for (let i = 0; i < entities.length; i += PK_CHUNK_SIZE) {
    chunks.push(entities.slice(i, i + PK_CHUNK_SIZE));
  }

  const results = await Promise.all(
    chunks.map((chunk) => {
      const where = buildPKWhereClause(pkFields, chunk);
      if (!where) return Promise.resolve([]);
      return delegate.findMany({ where });
    }),
  );

  return results.flat();
};
