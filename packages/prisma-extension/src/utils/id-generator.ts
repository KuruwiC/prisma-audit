/**
 * ID Generation Utilities (Prisma Adapter)
 *
 * Prisma-specific adapter for ID generation.
 * Wraps the core id-generator and provides Prisma DMMF-based schema metadata.
 *
 * @module id-generator
 */

import type { SchemaMetadata } from '@kuruwic/prisma-audit-core';
import {
  ensureIds as coreEnsureIds,
  getIdFieldInfo as coreGetIdFieldInfo,
  getIdGenerator,
  ID_GENERATORS,
  type IdFieldInfo,
  type IdGenerator,
} from '@kuruwic/prisma-audit-core';

// Re-export core types and functions
export type { IdGenerator, IdFieldInfo };
export { ID_GENERATORS, getIdGenerator };

/**
 * Prisma DMMF (Data Model Meta Format) type definitions
 */
interface PrismaDMMFField {
  name: string;
  kind: string;
  type: string;
  isList?: boolean;
  isRequired?: boolean;
  isUnique?: boolean;
  isId?: boolean;
  hasDefaultValue?: boolean;
  default?: unknown;
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
 * Create schema metadata adapter from Prisma DMMF
 *
 * @internal
 */
const createSchemaMetadataFromDMMF = (Prisma: PrismaNamespace): SchemaMetadata => {
  return {
    getUniqueConstraints: () => {
      // Not needed for id-generator, return empty array
      return [];
    },
    getRelationFields: () => {
      // Not needed for id-generator, return empty array
      return [];
    },
    getAllFields: (modelName: string) => {
      const dmmf = Prisma.dmmf;
      if (!dmmf?.datamodel?.models) {
        return [];
      }

      const model = dmmf.datamodel.models.find((m) => m.name === modelName);
      if (!model) {
        return [];
      }

      return model.fields.map((f) => ({
        name: f.name,
        type: f.type,
        kind: f.kind,
        isRequired: f.isRequired ?? false,
        isUnique: f.isUnique ?? false,
        isId: f.isId ?? false,
        isList: f.isList ?? false,
        hasDefaultValue: !!f.default,
        default: f.default,
        defaultExpr: undefined,
      }));
    },
    getFieldMetadata: (modelName: string, fieldName: string) => {
      const dmmf = Prisma.dmmf;
      if (!dmmf?.datamodel?.models) {
        return undefined;
      }

      const model = dmmf.datamodel.models.find((m) => m.name === modelName);
      if (!model) {
        return undefined;
      }

      const field = model.fields.find((f) => f.name === fieldName);
      if (!field) {
        return undefined;
      }

      return {
        name: field.name,
        type: field.type,
        kind: field.kind,
        isRequired: field.isRequired ?? false,
        isUnique: field.isUnique ?? false,
        isId: field.isId ?? false,
        isList: field.isList ?? false,
        hasDefaultValue: !!field.default,
        default: field.default,
        defaultExpr: undefined,
      };
    },
  };
};

/**
 * Get ID field information from Prisma DMMF
 */
export const getIdFieldInfo = (Prisma: PrismaNamespace, modelName: string, idKey = 'id'): IdFieldInfo | undefined => {
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
  Prisma: PrismaNamespace,
  modelName: string,
  entities: T[],
  idKey = 'id',
): T[] => {
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  return coreEnsureIds(schemaMetadata, modelName, entities, idKey);
};
