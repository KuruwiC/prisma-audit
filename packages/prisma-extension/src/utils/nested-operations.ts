/**
 * Nested Operations Utilities (Prisma Adapter)
 *
 * Provides Prisma-specific adapters for detecting and extracting nested operations.
 * Wraps core nested-operations logic with DMMF-based schema metadata.
 *
 * @module nested-operations
 */

import type { DbClient, NestedDetectionPass } from '@kuruwic/prisma-audit-core';
import {
  detectNestedOperations as coreDetectNestedOperations,
  extractNestedRecords as coreExtractNestedRecords,
  refetchNestedRecords as coreRefetchNestedRecords,
  NESTED_OPERATION_KEYWORDS,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  type NestedRecordInfo,
} from '@kuruwic/prisma-audit-core';

import { createSchemaMetadataFromDMMF, type PrismaWithDMMF } from './schema-metadata.js';

export { createSchemaMetadataFromDMMF };

// Re-export core types and constants
export type { NestedOperationInfo, NestedOperationKeyword, NestedRecordInfo };
export { NESTED_OPERATION_KEYWORDS };

/**
 * Relation field information (Prisma-specific)
 */
export interface RelationFieldInfo {
  /** Field name (e.g., 'posts') */
  name: string;
  /** Related model name (e.g., 'Post') */
  relatedModel: string;
  /** Whether this is a list/array relation */
  isList: boolean;
  /** Whether this relation is required */
  isRequired: boolean;
  /** Relation name from schema (optional) */
  relationName?: string;
}

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
 * Get all relation fields for a given model from Prisma DMMF
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @returns Array of relation field information
 */
export const getRelationFields = (Prisma: PrismaWithDMMF, modelName: string): RelationFieldInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return schemaMetadata.getRelationFields(modelName);
};

/**
 * Detect nested operations in Prisma operation args (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param args - Prisma operation args
 * @param pass - Which upsert branches to scan (see `NestedDetectionPass`)
 * @returns Array of detected nested operations
 */
export const detectNestedOperations = (
  Prisma: PrismaWithDMMF,
  modelName: string,
  args: Record<string, unknown>,
  pass: NestedDetectionPass,
): NestedOperationInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreDetectNestedOperations(schemaMetadata, modelName, args, pass);
};

/**
 * Extract nested records from Prisma operation result (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param result - Prisma operation result
 * @returns Array of nested record information
 */
export const extractNestedRecords = (
  Prisma: PrismaWithDMMF,
  modelName: string,
  result: unknown,
): NestedRecordInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreExtractNestedRecords(schemaMetadata, modelName, result);
};

/**
 * Re-fetch nested records after an operation when `include` is missing (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param prismaClient - Prisma client for executing queries
 * @param modelName - Parent model name (e.g., 'User')
 * @param nestedPreFetchResults - Pre-fetched nested records (before state)
 * @param nestedOperations - Detected nested operations
 * @returns Array of nested record information with re-fetched after state
 */
export const refetchNestedRecords = async (
  Prisma: PrismaWithDMMF,
  prismaClient: PrismaClientWithModels,
  modelName: string,
  nestedPreFetchResults: Map<string, Map<string, { before: Record<string, unknown> | null }>> | undefined,
  nestedOperations: NestedOperationInfo[],
): Promise<NestedRecordInfo[]> => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreRefetchNestedRecords(
    prismaClient as DbClient,
    schemaMetadata,
    modelName,
    nestedPreFetchResults,
    nestedOperations,
  );
};
