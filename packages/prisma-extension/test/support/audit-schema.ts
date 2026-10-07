/**
 * Hand-built audit schemas for unit specs: the data `prisma-audit-generator` emits, shaped the way
 * it shapes it, so a spec can describe exactly the models it needs.
 */

import type { AuditSchema } from '../../src/schema/audit-schema.js';
import { loadSchemaMetadata } from '../../src/schema/schema-metadata.js';
import type { SchemaMetadata } from '../../src/schema/types.js';

type AuditSchemaModel = AuditSchema['models'][number];
type AuditSchemaField = AuditSchemaModel['fields'][number];
type AuditSchemaColumn = Exclude<AuditSchemaField, { kind: 'object' }>;
type AuditSchemaRelation = Extract<AuditSchemaField, { kind: 'object' }>;
type AuditSchemaKey = NonNullable<AuditSchemaModel['primaryKey']>;

/** A scalar `String` column that is optional, not a key, and has no default unless `overrides` say so */
export const column = (name: string, overrides: Partial<Omit<AuditSchemaColumn, 'name'>> = {}): AuditSchemaColumn => ({
  name,
  kind: 'scalar',
  type: 'String',
  isList: false,
  isRequired: false,
  isId: false,
  isUnique: false,
  isUpdatedAt: false,
  hasDefaultValue: false,
  default: null,
  ...overrides,
});

/** A relation field to `relatedModel`; to-one and optional, with no foreign key, unless `overrides` say so */
export const relation = (
  name: string,
  relatedModel: string,
  relationName: string,
  overrides: Partial<Pick<AuditSchemaRelation, 'isList' | 'isRequired' | 'foreignKeyFields' | 'referencedFields'>> = {},
): AuditSchemaRelation => ({
  name,
  kind: 'object',
  relatedModel,
  isList: false,
  isRequired: false,
  relationName,
  foreignKeyFields: [],
  referencedFields: [],
  ...overrides,
});

export interface ModelConstraints {
  /** The `@@id`; without it the model's `isId` column is its primary key */
  readonly primaryKey?: AuditSchemaKey;
  /** The `@@unique` constraints, in declaration order */
  readonly uniqueIndexes?: readonly AuditSchemaKey[];
}

/**
 * A model with the constraints the generator derives from its fields: the primary key is the
 * `@@id`, else the `isId` column with a null name; the unique constraints are the `isUnique`
 * columns in field order, then the `@@unique` indexes.
 */
export const model = (
  name: string,
  fields: readonly AuditSchemaField[],
  constraints: ModelConstraints = {},
): AuditSchemaModel => {
  const idColumn = fields.find((field) => field.kind !== 'object' && field.isId);
  return {
    name,
    fields,
    primaryKey: constraints.primaryKey ?? (idColumn ? { fields: [idColumn.name], name: null } : null),
    uniqueConstraints: [
      ...fields
        .filter((field) => field.kind !== 'object' && field.isUnique)
        .map((field) => ({ type: 'uniqueField' as const, fields: [field.name], name: null })),
      ...(constraints.uniqueIndexes ?? []).map((index) => ({ type: 'uniqueIndex' as const, ...index })),
    ],
  };
};

export const auditSchema = (...models: AuditSchemaModel[]): AuditSchema => ({ formatVersion: 1, models });

export const schemaMetadataOf = (...models: AuditSchemaModel[]): SchemaMetadata =>
  loadSchemaMetadata(auditSchema(...models));
