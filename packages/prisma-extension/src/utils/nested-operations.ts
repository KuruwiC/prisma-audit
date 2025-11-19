/**
 * Nested Operations Utilities (Prisma Adapter)
 *
 * Provides Prisma-specific adapters for detecting and extracting nested operations.
 * Wraps core nested-operations logic with DMMF-based schema metadata.
 *
 * @module nested-operations
 */

import type { DbClient, PreFetchResults, SchemaMetadata } from '@kuruwic/prisma-audit-core';
import {
  detectNestedDeletes as coreDetectNestedDeletes,
  detectNestedOperations as coreDetectNestedOperations,
  detectNestedUpdates as coreDetectNestedUpdates,
  detectNestedUpserts as coreDetectNestedUpserts,
  extractNestedRecords as coreExtractNestedRecords,
  isRelationField as coreIsRelationField,
  refetchNestedRecords as coreRefetchNestedRecords,
  createEmptyPreFetchResults,
  NESTED_OPERATION_KEYWORDS,
  type NestedOperationInfo,
  type NestedOperationKeyword,
  type NestedRecordInfo,
} from '@kuruwic/prisma-audit-core';

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
 * Prisma DMMF (Data Model Meta Format) type definitions
 */
interface PrismaDMMFField {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
  isList?: boolean;
  isRequired?: boolean;
}

interface PrismaDMMFModel {
  name: string;
  fields: PrismaDMMFField[];
}

interface PrismaNamespace {
  dmmf?: {
    datamodel?: {
      models?: PrismaDMMFModel[];
    };
  };
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
 * Create schema metadata adapter from Prisma DMMF
 *
 * @param Prisma - Prisma namespace with DMMF
 * @returns SchemaMetadata implementation
 */
export const createSchemaMetadataFromDMMF = (Prisma: PrismaNamespace): SchemaMetadata => {
  return {
    getUniqueConstraints: () => {
      return [];
    },
    getRelationFields: (modelName: string) => {
      try {
        const dmmf = Prisma.dmmf;
        if (!dmmf?.datamodel?.models) {
          return [];
        }

        const model = dmmf.datamodel.models.find((m) => m.name === modelName);
        if (!model) {
          return [];
        }

        const relationFields = model.fields.filter((f) => f.kind === 'object');

        return relationFields.map((field) => ({
          name: field.name,
          relatedModel: field.type,
          isList: field.isList ?? false,
          isRequired: field.isRequired ?? false,
          relationName: field.relationName,
        }));
      } catch {
        return [];
      }
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
 * Get all relation fields for a given model from Prisma DMMF
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @returns Array of relation field information
 */
export const getRelationFields = (Prisma: PrismaNamespace, modelName: string): RelationFieldInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return schemaMetadata.getRelationFields(modelName);
};

/**
 * Check if a field is a relation field (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param fieldName - Field name to check
 * @returns True if the field is a relation field
 */
export const isRelationField = (Prisma: PrismaNamespace, modelName: string, fieldName: string): boolean => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreIsRelationField(schemaMetadata, modelName, fieldName);
};

/**
 * Detect nested operations in Prisma operation args (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param args - Prisma operation args
 * @param preFetchResults - Pre-fetched records mapped by path (used to filter upsert branches)
 * @param currentPath - Current path in dot-notation for recursive tracking (default: '')
 * @returns Array of detected nested operations
 */
export const detectNestedOperations = (
  Prisma: PrismaNamespace,
  modelName: string,
  args: Record<string, unknown>,
  preFetchResults: PreFetchResults = createEmptyPreFetchResults(),
): NestedOperationInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreDetectNestedOperations(schemaMetadata, modelName, args, preFetchResults);
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
  Prisma: PrismaNamespace,
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
  Prisma: PrismaNamespace,
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

/**
 * Detect nested update operations in Prisma operation args (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param args - Prisma operation args
 * @returns Array of detected nested update operations
 */
export const detectNestedUpdates = (
  Prisma: PrismaNamespace,
  modelName: string,
  args: Record<string, unknown>,
): NestedOperationInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreDetectNestedUpdates(schemaMetadata, modelName, args);
};

/**
 * Detect nested delete operations in Prisma operation args (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param args - Prisma operation args
 * @returns Array of detected nested delete operations
 */
export const detectNestedDeletes = (
  Prisma: PrismaNamespace,
  modelName: string,
  args: Record<string, unknown>,
): NestedOperationInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreDetectNestedDeletes(schemaMetadata, modelName, args);
};

/**
 * Detect nested upsert operations in Prisma operation args (Prisma adapter)
 *
 * @param Prisma - Prisma namespace with DMMF
 * @param modelName - Model name (PascalCase)
 * @param args - Prisma operation args
 * @returns Array of detected nested upsert operations
 */
export const detectNestedUpserts = (
  Prisma: PrismaNamespace,
  modelName: string,
  args: Record<string, unknown>,
): NestedOperationInfo[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreDetectNestedUpserts(schemaMetadata, modelName, args);
};
