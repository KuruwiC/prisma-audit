/**
 * Pre-fetch Logic for Nested Operations (Prisma Adapter)
 *
 * Provides Prisma-specific adapters for pre-fetching "before" state.
 * Wraps core pre-fetch logic with DMMF-based schema metadata.
 *
 * @module pre-fetch
 */

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

import { createSchemaMetadataFromDMMF, getUniqueConstraints, type PrismaWithDMMF } from './schema-metadata.js';

export type { ParsedWhereClause, PreFetchResult };
export { buildPreFetchQuery, executePreFetch, getUniqueConstraints, hasOrNot, matchesUniqueConstraint };

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
 * Parse WHERE clause to determine query type and transform if needed (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param where - Original WHERE clause
 * @returns Parsed WHERE clause information
 */
export const parseWhereClause = (
  Prisma: PrismaWithDMMF,
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
  Prisma: PrismaWithDMMF,
  modelName: string,
  where: Record<string, unknown>,
): Promise<PreFetchResult<T>> => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return corePreFetchBeforeState<T>(client, schemaMetadata, modelName, where);
};
