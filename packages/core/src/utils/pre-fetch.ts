/**
 * Pre-fetch Logic for Nested Operations
 *
 * @module pre-fetch
 *
 * @remarks
 * Fetches the "before" state of records for update/delete operations in audit logging.
 *
 * **Smart query selection:**
 * - Uses `findUnique` when WHERE matches a unique constraint (faster, single result)
 * - Uses `findMany` for complex WHERE clauses (OR, NOT, partial matches)
 *
 * **Unique constraints supported:**
 * - Primary keys: `@id` or `@@id`
 * - Unique fields: `@unique`
 * - Unique indexes: `@@unique([field1, field2])`
 *
 * @since Phase 2
 */

import type { DbClient, SchemaMetadata, UniqueConstraint } from '../interfaces/index.js';

/**
 * Parsed WHERE clause information
 */
export interface ParsedWhereClause {
  type: 'findUnique' | 'findMany';
  where: Record<string, unknown>;
  originalWhere: Record<string, unknown>;
}

/**
 * Result of pre-fetch operation
 */
export interface PreFetchResult<T = unknown> {
  before: T | T[] | null;
  success: boolean;
  error?: string;
}

/**
 * Check if WHERE clause contains OR/NOT operators (including nested)
 *
 * @example
 * ```typescript
 * hasOrNot({ id: 'user-1' }); // false
 * hasOrNot({ OR: [{ id: 'user-1' }, { email: 'user@example.com' }] }); // true
 * hasOrNot({ AND: [{ id: 'user-1' }, { NOT: { status: 'deleted' } }] }); // true
 * ```
 */
export const hasOrNot = (where: Record<string, unknown>): boolean => {
  if (where.OR || where.NOT) {
    return true;
  }

  if (where.AND && Array.isArray(where.AND)) {
    return where.AND.some((clause) => {
      if (typeof clause === 'object' && clause !== null) {
        return hasOrNot(clause as Record<string, unknown>);
      }
      return false;
    });
  }

  return false;
};

/**
 * Check if WHERE clause matches a unique constraint
 *
 * @remarks
 * For composite keys, WHERE must contain exactly the constraint fields (no extras)
 *
 * @example
 * ```typescript
 * const constraints = [
 *   { type: 'primaryKey', fields: ['id'] },
 *   { type: 'uniqueIndex', fields: ['firstName', 'lastName'], name: 'firstName_lastName' }
 * ];
 *
 * matchesUniqueConstraint({ id: 'user-1' }, constraints);
 * // => { type: 'primaryKey', fields: ['id'] }
 *
 * matchesUniqueConstraint({ firstName: 'John', lastName: 'Doe' }, constraints);
 * // => { type: 'uniqueIndex', fields: ['firstName', 'lastName'], name: 'firstName_lastName' }
 *
 * matchesUniqueConstraint({ firstName: 'John' }, constraints);
 * // => null (incomplete composite key)
 * ```
 */
export const matchesUniqueConstraint = (
  where: Record<string, unknown>,
  constraints: UniqueConstraint[],
): UniqueConstraint | null => {
  const whereKeys = Object.keys(where).filter((key) => key !== 'AND' && key !== 'OR' && key !== 'NOT');

  for (const constraint of constraints) {
    const hasAllFields = constraint.fields.every((field) => whereKeys.includes(field));
    const hasOnlyConstraintFields = whereKeys.length === constraint.fields.length;

    if (hasAllFields && hasOnlyConstraintFields) {
      return constraint;
    }
  }

  return null;
};

/**
 * Parse WHERE clause to determine query type and transform if needed
 *
 * @param schemaMetadata - Schema metadata provider
 * @param modelName - Model name (PascalCase)
 * @param where - Original WHERE clause
 *
 * @example
 * ```typescript
 * // Simple unique field
 * parseWhereClause(schemaMetadata, 'User', { id: 'user-1' });
 * // => { type: 'findUnique', where: { id: 'user-1' }, originalWhere: { id: 'user-1' } }
 *
 * // Composite unique key
 * parseWhereClause(schemaMetadata, 'User', { firstName: 'John', lastName: 'Doe' });
 * // => { type: 'findUnique', where: { firstName_lastName: { firstName: 'John', lastName: 'Doe' } }, ... }
 * ```
 */
export const parseWhereClause = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  where: Record<string, unknown>,
): ParsedWhereClause => {
  const originalWhere = where;

  if (hasOrNot(where)) {
    return {
      type: 'findMany',
      where,
      originalWhere,
    };
  }

  const constraints = schemaMetadata.getUniqueConstraints(modelName);
  const matchedConstraint = matchesUniqueConstraint(where, constraints);

  if (!matchedConstraint) {
    return {
      type: 'findMany',
      where,
      originalWhere,
    };
  }

  // Transform composite keys to Prisma's expected format
  if (matchedConstraint.type === 'uniqueIndex' && matchedConstraint.name) {
    const compositeWhere: Record<string, unknown> = {};
    for (const field of matchedConstraint.fields) {
      compositeWhere[field] = where[field];
    }

    return {
      type: 'findUnique',
      where: {
        [matchedConstraint.name]: compositeWhere,
      },
      originalWhere,
    };
  }

  if (matchedConstraint.type === 'primaryKey' && matchedConstraint.fields.length > 1 && matchedConstraint.name) {
    const compositeWhere: Record<string, unknown> = {};
    for (const field of matchedConstraint.fields) {
      compositeWhere[field] = where[field];
    }

    return {
      type: 'findUnique',
      where: {
        [matchedConstraint.name]: compositeWhere,
      },
      originalWhere,
    };
  }

  return {
    type: 'findUnique',
    where,
    originalWhere,
  };
};

/**
 * Build pre-fetch query based on parsed WHERE clause
 */
export const buildPreFetchQuery = (
  parsed: ParsedWhereClause,
): { type: 'findUnique' | 'findMany'; where: Record<string, unknown> } => {
  return {
    type: parsed.type,
    where: parsed.where,
  };
};

/**
 * Execute pre-fetch query
 *
 * @param client - Database client (transaction-aware)
 * @param modelName - Model name (lowercase for client access, e.g., 'user')
 * @param query - Query to execute
 */
export const executePreFetch = async <T = unknown>(
  client: DbClient,
  modelName: string,
  query: { type: 'findUnique' | 'findMany'; where: Record<string, unknown> },
): Promise<PreFetchResult<T>> => {
  try {
    const model = client[modelName];
    if (!model) {
      return {
        before: null,
        success: false,
        error: `Model ${modelName} not found`,
      };
    }

    if (query.type === 'findUnique') {
      if (!model.findUnique) {
        return {
          before: null,
          success: false,
          error: `findUnique not available on model ${modelName}`,
        };
      }
      const record = (await model.findUnique({ where: query.where })) as T | null;
      return {
        before: record,
        success: true,
      };
    }

    if (!model.findMany) {
      return {
        before: null,
        success: false,
        error: `findMany not available on model ${modelName}`,
      };
    }
    const records = (await model.findMany({ where: query.where })) as T[];
    return {
      before: records as T | T[] | null,
      success: true,
    };
  } catch (error) {
    return {
      before: null,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Main entry point for pre-fetching "before" state
 *
 * @param client - Database client (transaction-aware)
 * @param schemaMetadata - Schema metadata provider
 * @param modelName - Model name (PascalCase for schema metadata, lowercase for client)
 * @param where - WHERE clause from the operation
 */
export const preFetchBeforeState = async <T = unknown>(
  client: DbClient,
  schemaMetadata: SchemaMetadata,
  modelName: string,
  where: Record<string, unknown>,
): Promise<PreFetchResult<T>> => {
  const parsed = parseWhereClause(schemaMetadata, modelName, where);
  const query = buildPreFetchQuery(parsed);
  const clientModelName = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const result = await executePreFetch<T>(client, clientModelName, query);

  return result;
};
