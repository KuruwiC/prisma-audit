/**
 * Pre-fetch Logic for Nested Operations (Prisma Adapter)
 *
 * Provides Prisma-specific adapters for pre-fetching "before" state.
 * Wraps core pre-fetch logic with DMMF-based schema metadata.
 *
 * @module pre-fetch
 */

import type { SchemaMetadata, UniqueConstraint } from '@kuruwic/prisma-audit-core';
import {
  buildPreFetchQuery,
  parseWhereClause as coreParseWhereClause,
  preFetchBeforeState as corePreFetchBeforeState,
  executePreFetch,
  hasOrNot,
  matchesUniqueConstraint,
  type ParsedWhereClause,
  type PreFetchResult,
} from '@kuruwic/prisma-audit-core';

export type { ParsedWhereClause, PreFetchResult };
export { buildPreFetchQuery, executePreFetch, hasOrNot, matchesUniqueConstraint };

/**
 * Prisma Client with dynamic model access
 */
interface PrismaClientWithModels {
  [modelName: string]: {
    findUnique?: (args: { where: Record<string, unknown> }) => Promise<unknown>;
    findMany?: (args: { where: Record<string, unknown> }) => Promise<unknown[]>;
  };
}

/**
 * Prisma DMMF (Data Model Meta Format) type definitions
 */
interface PrismaDMMFField {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
  isList?: boolean;
  isRequired?: boolean;
  isUnique?: boolean;
  isId?: boolean;
}

interface PrismaDMMFModel {
  name: string;
  fields: PrismaDMMFField[];
  primaryKey?: {
    name: string | null;
    fields: string[];
  };
  uniqueFields?: string[][];
  uniqueIndexes?: Array<{
    name: string | null;
    fields: string[];
  }>;
}

interface PrismaNamespace {
  dmmf?: {
    datamodel?: {
      models?: PrismaDMMFModel[];
    };
  };
}

/**
 * Get all unique constraints for a model from Prisma DMMF
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @returns Array of unique constraints
 *
 * @example
 * ```typescript
 * const constraints = getUniqueConstraints(Prisma, 'User');
 * // Result: [
 * //   { type: 'primaryKey', fields: ['id'] },
 * //   { type: 'uniqueField', fields: ['email'] },
 * //   { type: 'uniqueIndex', fields: ['firstName', 'lastName'], name: 'firstName_lastName' }
 * // ]
 * ```
 */
export const getUniqueConstraints = (Prisma: PrismaNamespace, modelName: string): UniqueConstraint[] => {
  const constraints: UniqueConstraint[] = [];

  try {
    const dmmf = Prisma.dmmf;
    if (!dmmf?.datamodel?.models) {
      return constraints;
    }

    const model = dmmf.datamodel.models.find((m) => m.name === modelName);
    if (!model) {
      return constraints;
    }

    // 1. Primary Key
    if (model.primaryKey) {
      constraints.push({
        type: 'primaryKey',
        fields: model.primaryKey.fields,
        name: model.primaryKey.name,
      });
    }

    // 2. Unique Fields (@unique)
    const uniqueFields = model.fields.filter((f) => f.isUnique === true);
    for (const field of uniqueFields) {
      constraints.push({
        type: 'uniqueField',
        fields: [field.name],
      });
    }

    // 3. Unique Indexes (@@unique)
    if (model.uniqueIndexes && Array.isArray(model.uniqueIndexes)) {
      for (const index of model.uniqueIndexes) {
        constraints.push({
          type: 'uniqueIndex',
          fields: index.fields,
          name: index.name,
        });
      }
    }

    return constraints;
  } catch {
    return constraints;
  }
};

/**
 * Create schema metadata adapter from Prisma DMMF
 *
 * @param Prisma - Prisma namespace with DMMF
 * @returns SchemaMetadata implementation
 */
const createSchemaMetadataFromDMMF = (Prisma: PrismaNamespace): SchemaMetadata => {
  return {
    getUniqueConstraints: (modelName: string) => {
      return getUniqueConstraints(Prisma, modelName);
    },
    getRelationFields: () => {
      return [];
    },
    getAllFields: () => {
      return [];
    },
    getFieldMetadata: () => {
      return undefined;
    },
  };
};

/**
 * Parse WHERE clause to determine query type and transform if needed (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param where - Original WHERE clause
 * @returns Parsed WHERE clause information
 */
export const parseWhereClause = (
  Prisma: PrismaNamespace,
  modelName: string,
  where: Record<string, unknown>,
): ParsedWhereClause => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreParseWhereClause(schemaMetadata, modelName, where);
};

/**
 * Main entry point for pre-fetching "before" state (Prisma adapter)
 *
 * @param client - Prisma client (transaction-aware)
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase for DMMF, lowercase for client)
 * @param where - WHERE clause from the operation
 * @returns Pre-fetch result
 *
 * @example
 * ```typescript
 * const result = await preFetchBeforeState(
 *   prisma,
 *   Prisma,
 *   'User',
 *   { id: 'user-1' }
 * );
 *
 * if (result.success) {
 *   console.log('Before state:', result.before);
 * } else {
 *   console.error('Pre-fetch failed:', result.error);
 * }
 * ```
 */
export const preFetchBeforeState = async <T = unknown>(
  client: PrismaClientWithModels,
  Prisma: PrismaNamespace,
  modelName: string,
  where: Record<string, unknown>,
): Promise<PreFetchResult<T>> => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return corePreFetchBeforeState<T>(client, schemaMetadata, modelName, where);
};
