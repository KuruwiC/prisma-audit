/**
 * Schema Metadata Types
 *
 * The model structure the adapter reads from the Prisma schema at runtime: unique
 * constraints, relation fields, and scalar fields. `loadSchemaMetadata` builds it from the
 * audit schema `prisma-audit-generator` emits.
 *
 * @module schema/types
 */

/**
 * Every query that takes a model name throws when the schema holds no such model; a field name the
 * model lacks reads `undefined`.
 */
export interface SchemaMetadata {
  /** The names of every model, in the order the schema declares them */
  getModelNames(): readonly string[];
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

export interface RelationField {
  name: string;
  relatedModel: string;
  isList: boolean;
  isRequired: boolean;
  relationName: string;
  /** The fields of this model that hold the relation's foreign key; empty when the related model holds it */
  foreignKeyFields: string[];
  /** The fields of the related model that `foreignKeyFields` reference, in the same order; empty when the related model holds the foreign key */
  referencedFields: string[];
}

export interface FieldMetadata {
  name: string;
  type: string;
  kind: string;
  isRequired: boolean;
  isUnique: boolean;
  isId: boolean;
  isList: boolean;
  hasDefaultValue: boolean;
  /** `@updatedAt`: Prisma sets the column on every write */
  isUpdatedAt: boolean;
  /** The function of a function default such as `uuid(7)`; absent for a literal default or none */
  default?: FieldDefault;
}

/** A function default: `uuid(7)` is `{ name: 'uuid', args: [7] }` */
export interface FieldDefault {
  readonly name: string;
  readonly args: readonly (string | number)[];
}
