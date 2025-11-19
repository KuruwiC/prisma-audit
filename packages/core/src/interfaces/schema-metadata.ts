/**
 * Schema Metadata Interfaces
 *
 * Framework-agnostic interfaces for runtime introspection of database schemas.
 * Enables access to model structure, constraints, and relationships.
 *
 * @packageDocumentation
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
