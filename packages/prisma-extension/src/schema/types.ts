/**
 * Schema Metadata Types
 *
 * The model structure the adapter reads from the Prisma schema at runtime: unique
 * constraints, relation fields, and scalar fields. `createSchemaMetadataFromDMMF`
 * builds it from the DMMF.
 *
 * @module schema/types
 */

/**
 * Schema metadata provider interface
 *
 * Provides runtime access to Prisma schema information.
 */
export interface SchemaMetadata {
  getUniqueConstraints(modelName: string): UniqueConstraint[];
  getRelationFields(modelName: string): RelationField[];
  getAllFields(modelName: string): FieldMetadata[];
  getFieldMetadata(modelName: string, fieldName: string): FieldMetadata | undefined;
}

/**
 * Unique constraint metadata
 *
 * @example
 * ```typescript
 * { type: 'primaryKey', fields: ['id'] }
 * { type: 'uniqueField', fields: ['email'] }
 * { type: 'uniqueIndex', fields: ['userId', 'postId'], name: 'user_post_unique' }
 * ```
 */
export interface UniqueConstraint {
  type: 'primaryKey' | 'uniqueField' | 'uniqueIndex';
  fields: string[];
  name?: string | null;
}

/**
 * Relation field metadata
 */
export interface RelationField {
  name: string;
  relatedModel: string;
  isList: boolean;
  isRequired: boolean;
  relationName?: string;
}

/**
 * Field metadata from Prisma schema
 */
export interface FieldMetadata {
  name: string;
  type: string;
  kind: string;
  isRequired: boolean;
  isUnique: boolean;
  isId: boolean;
  isList: boolean;
  hasDefaultValue: boolean;
  default?: unknown;
  defaultExpr?: string;
}
