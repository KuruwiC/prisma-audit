/**
 * Datamodel to audit schema
 *
 * Maps the datamodel Prisma hands a generator to the data `@kuruwic/prisma-audit` reads at runtime.
 * Only `datamodel` is read: it is the part of the generator options that is identical across Prisma
 * versions.
 *
 * @module to-audit-schema
 */

import type { AuditSchema } from '@kuruwic/prisma-audit';
import type { DMMF } from '@prisma/generator-helper';

type Model = AuditSchema['models'][number];
type Field = Model['fields'][number];
type Column = Extract<Field, { kind: 'scalar' | 'enum' | 'unsupported' }>;
type Relation = Extract<Field, { kind: 'object' }>;
type Unique = Model['uniqueConstraints'][number];

/** A default that names a function (`uuid(7)`, `now()`); a literal default is a bare value or a list */
const isFunctionDefault = (value: DMMF.Field['default']): value is DMMF.FieldDefault =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toColumn = (field: DMMF.Field, kind: Column['kind']): Column => ({
  name: field.name,
  kind,
  type: field.type,
  isList: field.isList,
  isRequired: field.isRequired,
  isId: field.isId,
  isUnique: field.isUnique,
  isUpdatedAt: field.isUpdatedAt ?? false,
  hasDefaultValue: field.hasDefaultValue || field.default !== undefined,
  default: isFunctionDefault(field.default) ? { name: field.default.name, args: [...field.default.args] } : null,
});

const toRelation = (modelName: string, field: DMMF.Field): Relation => {
  if (field.relationName === undefined) {
    throw new Error(`[prisma-audit-generator] Relation field "${modelName}.${field.name}" has no relation name.`);
  }
  return {
    name: field.name,
    kind: 'object',
    relatedModel: field.type,
    isList: field.isList,
    isRequired: field.isRequired,
    relationName: field.relationName,
    foreignKeyFields: [...(field.relationFromFields ?? [])],
    referencedFields: [...(field.relationToFields ?? [])],
  };
};

const toField = (modelName: string, field: DMMF.Field): Field =>
  field.kind === 'object' ? toRelation(modelName, field) : toColumn(field, field.kind);

const toPrimaryKey = (model: DMMF.Model): Model['primaryKey'] => {
  if (model.primaryKey) {
    return { fields: [...model.primaryKey.fields], name: model.primaryKey.name };
  }
  const idField = model.fields.find((field) => field.isId);
  return idField ? { fields: [idField.name], name: null } : null;
};

const toUniqueConstraints = (model: DMMF.Model): Unique[] => [
  ...model.fields
    .filter((field) => field.isUnique)
    .map((field): Unique => ({ type: 'uniqueField', fields: [field.name], name: null })),
  ...model.uniqueIndexes.map((index): Unique => ({ type: 'uniqueIndex', fields: [...index.fields], name: index.name })),
];

const toModel = (model: DMMF.Model): Model => ({
  name: model.name,
  fields: model.fields.map((field) => toField(model.name, field)),
  primaryKey: toPrimaryKey(model),
  uniqueConstraints: toUniqueConstraints(model),
});

/**
 * The audit schema of a datamodel: models, fields and uniques in declaration order.
 *
 * @throws Error if a relation field has no relation name
 */
export const toAuditSchema = (datamodel: DMMF.Datamodel): AuditSchema => ({
  formatVersion: 1,
  models: datamodel.models.map(toModel),
});
