/**
 * ID Generation Utilities
 *
 * Provides client-side ID generation for createMany operations where ORMs
 * don't auto-generate IDs despite schema defaults.
 *
 * **Supported generators:**
 * - `cuid()` / `cuid2()`: CUID v2
 * - `uuid()`: UUID v4
 *
 * **Unsupported (database-generated):**
 * - `autoincrement()`: Requires database INSERT
 * - `dbgenerated()`: Requires database trigger/function
 *
 * @example
 * ```typescript
 * const dataWithIds = ensureIds(schemaMetadata, 'User', [
 *   { email: 'user1@example.com' },
 *   { email: 'user2@example.com' },
 * ]);
 * // => [
 * //   { id: 'cm4x...', email: 'user1@example.com' },
 * //   { id: 'cm4y...', email: 'user2@example.com' },
 * // ]
 * ```
 */

import { createId } from '@paralleldrive/cuid2';
import type { SchemaMetadata } from '../interfaces/index.js';

/**
 * ID generator function type
 */
export type IdGenerator = () => string;

/**
 * Supported ID generation strategies
 */
export const ID_GENERATORS: Record<string, IdGenerator> = {
  cuid: () => createId(),
  cuid2: () => createId(),
  uuid: () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    throw new Error(
      'UUID generation requires Node.js 18+ with crypto.randomUUID() or a polyfill. ' +
        'Consider using cuid2 instead: @default(cuid())',
    );
  },
};

/**
 * Get ID generator for a given default expression
 *
 * @example
 * ```typescript
 * const generator = getIdGenerator('cuid()');
 * if (generator) {
 *   const id = generator();
 * }
 * ```
 */
export const getIdGenerator = (defaultExpr: string): IdGenerator | undefined => {
  const match = defaultExpr.match(/^(\w+)\(\)$/);
  if (!match || !match[1]) {
    return undefined;
  }

  const functionName = match[1].toLowerCase();
  return ID_GENERATORS[functionName];
};

/**
 * ID field inspection result
 */
export interface IdFieldInfo {
  name: string;
  hasDefault: boolean;
  generator?: IdGenerator;
  defaultExpr?: string;
}

/**
 * Get ID field information from schema metadata
 */
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
        const defaultExpr = `${defaultValue.name}()`;
        info.defaultExpr = defaultExpr;
        info.generator = getIdGenerator(defaultExpr);
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
        `Supported defaults: cuid(), cuid2(), uuid(). ` +
        `For database-generated IDs like autoincrement() or dbgenerated(), ` +
        `audit logging with createMany is not supported. Please use individual create() calls instead.`,
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
