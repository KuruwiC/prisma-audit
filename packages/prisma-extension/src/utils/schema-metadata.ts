/**
 * Schema Metadata Utilities
 *
 * Provides runtime access to Prisma schema metadata and DMMF (Data Model Meta Format).
 * Enables dynamic inspection of models, fields, and relationships.
 *
 * @module utils/schema-metadata
 */

import type { SchemaMetadata, UniqueConstraint } from '@kuruwic/prisma-audit-core';

import type { DMMFModel } from '../internal-types.js';

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
