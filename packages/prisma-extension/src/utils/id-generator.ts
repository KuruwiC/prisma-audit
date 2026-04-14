/**
 * ID Generation Utilities (Prisma Adapter)
 *
 * Prisma-specific adapter for ID generation.
 * Wraps the core id-generator and provides Prisma DMMF-based schema metadata.
 *
 * @module id-generator
 */

import {
  ensureIds as coreEnsureIds,
  getIdFieldInfo as coreGetIdFieldInfo,
  getIdGenerator,
  ID_GENERATORS,
  type IdFieldInfo,
  type IdGenerator,
} from '@kuruwic/prisma-audit-core';

import { createSchemaMetadataFromDMMF, type PrismaWithDMMF } from './schema-metadata.js';

// Re-export core types and functions
export type { IdGenerator, IdFieldInfo };
export { ID_GENERATORS, getIdGenerator };

/**
 * Get ID field information from Prisma DMMF
 */
export const getIdFieldInfo = (Prisma: PrismaWithDMMF, modelName: string, idKey = 'id'): IdFieldInfo | undefined => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreGetIdFieldInfo(schemaMetadata, modelName, idKey);
};

/**
 * Generate missing IDs for entities in createMany data
 *
 * @throws Error if ID generation is required but not possible
 *
 * @example
 * ```typescript
 * const dataWithIds = ensureIds(Prisma, 'User', [
 *   { email: 'user1@example.com' },
 *   { email: 'user2@example.com' },
 * ]);
 * // => [
 * //   { id: 'cm4x...', email: 'user1@example.com' },
 * //   { id: 'cm4y...', email: 'user2@example.com' },
 * // ]
 * ```
 */
export const ensureIds = <T extends Record<string, unknown>>(
  Prisma: PrismaWithDMMF,
  modelName: string,
  entities: T[],
  idKey = 'id',
): T[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreEnsureIds(schemaMetadata, modelName, entities, idKey);
};

/**
 * Primary Key Extraction Utilities
 *
 * Used for identity-based before/after matching in batch operations.
 * These use DMMF-based synchronous PK extraction (not the async idResolver
 * which is for audit log entityId resolution).
 */

const PK_CHUNK_SIZE = 1000;

/**
 * Get primary key field names for a model from DMMF.
 *
 * Priority: @@id composite key → @id scalar field → error
 *
 * @throws Error if model has no primary key
 */
export const getPrimaryKeyFields = (Prisma: PrismaWithDMMF, modelName: string): string[] => {
  const dmmf = Prisma.dmmf;
  if (!dmmf?.datamodel?.models) {
    throw new Error(`[@prisma-audit] DMMF not available, cannot determine primary key for ${modelName}`);
  }

  const model = dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) {
    throw new Error(`[@prisma-audit] Model "${modelName}" not found in DMMF`);
  }

  // @@id composite key takes precedence
  if (model.primaryKey?.fields && model.primaryKey.fields.length > 0) {
    return model.primaryKey.fields;
  }

  // @id scalar field
  const idField = model.fields.find((f) => f.isId === true);
  if (idField) {
    return [idField.name];
  }

  throw new Error(
    `[@prisma-audit] Model "${modelName}" has no primary key. ` +
      'Batch audit operations require a primary key for before/after state matching.',
  );
};

/**
 * Extract a stable string key from an entity's primary key fields.
 *
 * Uses JSON.stringify for collision safety with composite keys
 * (e.g. ["a:b", "c"] vs ["a", "b:c"] are distinguishable).
 */
export const extractPrimaryKey = (entity: Record<string, unknown>, pkFields: string[]): string => {
  if (pkFields.length === 1) {
    const field = pkFields[0] as string;
    return String(entity[field]);
  }
  return JSON.stringify(pkFields.map((f) => entity[f]));
};

/** Default key used when PK fields are missing from a record */
export const ENTITY_IDENTITY_DEFAULT = '__default__';

/**
 * Extract entity identity string with fallback for missing PK fields.
 *
 * Unlike `extractPrimaryKey` (which assumes all fields exist), this returns
 * `__default__` when any PK field is absent. BigInt-safe serialization.
 */
export const extractEntityIdentity = (record: Record<string, unknown>, pkFields: string[]): string => {
  const allPresent = pkFields.every((f) => f in record && record[f] != null);
  if (!allPresent) return ENTITY_IDENTITY_DEFAULT;

  if (pkFields.length === 1) return String(record[pkFields[0] as string]);

  return JSON.stringify(
    pkFields.map((f) => {
      const v = record[f];
      return typeof v === 'bigint' ? v.toString() : v;
    }),
  );
};

/**
 * Build a Map from entities keyed by their primary key.
 */
export const buildEntityMap = (
  entities: ReadonlyArray<Record<string, unknown>>,
  pkFields: string[],
): Map<string, Record<string, unknown>> => {
  const map = new Map<string, Record<string, unknown>>();
  for (const entity of entities) {
    map.set(extractPrimaryKey(entity, pkFields), entity);
  }
  return map;
};

/**
 * Build a Prisma WHERE clause to re-fetch entities by their primary keys.
 *
 * - Single PK: `{ id: { in: [...] } }`
 * - Composite PK: `{ OR: [{ pk1: v1, pk2: v2 }, ...] }` (chunked for large sets)
 *
 * Returns null for empty entity lists to signal callers to skip the query.
 */
export const buildPKWhereClause = (
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

  // Composite PK: build OR conditions, chunked to avoid oversized queries
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
 * Fetch entities by primary keys with automatic chunking.
 *
 * Splits entities into batches of PK_CHUNK_SIZE, runs parallel findMany
 * calls, and merges results. This prevents exceeding database parameter limits.
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
