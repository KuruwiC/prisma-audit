/**
 * ID Generation Utilities
 *
 * Provides client-side ID generation for createMany operations where ORMs
 * don't auto-generate IDs despite schema defaults.
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

import cuidV1 from '@bugsnag/cuid';
import { createId } from '@paralleldrive/cuid2';
import { v4 as uuidV4, v7 as uuidV7 } from 'uuid';
import type { SchemaMetadata } from '../interfaces/index.js';

/**
 * ID generator function type
 */
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
