/**
 * Schema Metadata Utilities
 *
 * Provides runtime access to Prisma schema metadata and DMMF (Data Model Meta Format).
 * Enables dynamic inspection of models, fields, and relationships.
 *
 * @module utils/schema-metadata
 */

import type { SchemaMetadata, UniqueConstraint } from '@kuruwic/prisma-audit-core';

import type { DMMFModel, PrismaClientWithDynamicAccess, PrismaNamespace } from '../internal-types.js';

/**
 * Minimal DMMF-bearing type for schema metadata creation.
 * Accepts both the full PrismaNamespace and test mocks with only `dmmf`.
 */
export interface PrismaWithDMMF {
  dmmf?: {
    datamodel?: {
      models?: DMMFModel[];
    };
  };
}

/**
 * Get Prisma namespace from client instance
 *
 * Extracts the Prisma namespace from the client's constructor. This approach
 * works with any generated Prisma client (standard @prisma/client or custom output path)
 * without requiring @prisma/client as a runtime dependency.
 *
 * @param client - Prisma client instance (required)
 * @returns Prisma namespace object with defineExtension, dmmf, etc.
 * @throws {Error} If Prisma namespace cannot be extracted from the client
 *
 * @example
 * ```typescript
 * // Works with standard @prisma/client
 * import { PrismaClient } from '@prisma/client';
 * const prisma = new PrismaClient();
 * const Prisma = getPrisma(prisma);
 *
 * // Also works with custom output path
 * import { PrismaClient } from './generated/prisma';
 * const prisma = new PrismaClient();
 * const Prisma = getPrisma(prisma);
 * ```
 */
export const getPrisma = (client: PrismaClientWithDynamicAccess): PrismaNamespace => {
  const clientConstructor = Object.getPrototypeOf(client).constructor;

  if (clientConstructor && 'Prisma' in clientConstructor) {
    return clientConstructor.Prisma as PrismaNamespace;
  }

  // Fallback: Check globalThis for edge cases (e.g., browser environments)
  const globalPrisma = (globalThis as { Prisma?: unknown }).Prisma;
  if (globalPrisma) {
    return globalPrisma as PrismaNamespace;
  }

  throw new Error(
    '[@prisma-audit] Could not extract Prisma namespace from the provided client. ' +
      'Ensure you are passing a valid PrismaClient instance to the extension.',
  );
};

/**
 * Create a complete SchemaMetadata adapter from Prisma DMMF
 *
 * Provides all four SchemaMetadata methods using Prisma's DMMF.
 * This is the single source of truth for DMMF-to-SchemaMetadata conversion.
 */
export const createSchemaMetadataFromDMMF = (Prisma: PrismaWithDMMF): SchemaMetadata => {
  const findModel = (modelName: string) => {
    const dmmf = Prisma.dmmf;
    if (!dmmf?.datamodel?.models) return undefined;
    return dmmf.datamodel.models.find((m) => m.name === modelName);
  };

  return {
    getUniqueConstraints: (modelName: string): UniqueConstraint[] => {
      const constraints: UniqueConstraint[] = [];
      const model = findModel(modelName);
      if (!model) return constraints;

      if (model.primaryKey) {
        constraints.push({
          type: 'primaryKey',
          fields: model.primaryKey.fields,
          name: model.primaryKey.name,
        });
      }

      for (const field of model.fields) {
        if (field.isUnique === true) {
          constraints.push({ type: 'uniqueField', fields: [field.name] });
        }
      }

      if (model.uniqueIndexes && Array.isArray(model.uniqueIndexes)) {
        for (const index of model.uniqueIndexes) {
          constraints.push({ type: 'uniqueIndex', fields: index.fields, name: index.name });
        }
      }

      return constraints;
    },

    getRelationFields: (modelName: string) => {
      const model = findModel(modelName);
      if (!model) return [];

      return model.fields
        .filter((f) => f.kind === 'object')
        .map((field) => ({
          name: field.name,
          relatedModel: field.type,
          isList: field.isList ?? false,
          isRequired: field.isRequired ?? false,
          relationName: field.relationName,
        }));
    },

    getAllFields: (modelName: string) => {
      const model = findModel(modelName);
      if (!model) return [];

      return model.fields.map((f) => ({
        name: f.name,
        type: f.type,
        kind: f.kind,
        isRequired: f.isRequired ?? false,
        isUnique: f.isUnique ?? false,
        isId: f.isId ?? false,
        isList: f.isList ?? false,
        hasDefaultValue: !!f.hasDefaultValue || !!f.default,
        default: f.default,
        defaultExpr: undefined,
      }));
    },

    getFieldMetadata: (modelName: string, fieldName: string) => {
      const model = findModel(modelName);
      if (!model) return undefined;

      const field = model.fields.find((f) => f.name === fieldName);
      if (!field) return undefined;

      return {
        name: field.name,
        type: field.type,
        kind: field.kind,
        isRequired: field.isRequired ?? false,
        isUnique: field.isUnique ?? false,
        isId: field.isId ?? false,
        isList: field.isList ?? false,
        hasDefaultValue: !!field.hasDefaultValue || !!field.default,
        default: field.default,
        defaultExpr: undefined,
      };
    },
  };
};

/**
 * Get all unique constraints for a model from Prisma DMMF
 */
export const getUniqueConstraints = (Prisma: PrismaWithDMMF, modelName: string): UniqueConstraint[] => {
  return createSchemaMetadataFromDMMF(Prisma).getUniqueConstraints(modelName);
};
