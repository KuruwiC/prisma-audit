/**
 * Schema Metadata Loader
 *
 * Builds the {@link SchemaMetadata} the adapter reads every model's structure from, out of the audit
 * schema `prisma-audit-generator` emits at `prisma generate` time.
 *
 * @module schema/schema-metadata
 */

import type { AuditSchema } from './audit-schema.js';
import type { FieldMetadata, RelationField, SchemaMetadata, UniqueConstraint } from './types.js';

type AuditSchemaModel = AuditSchema['models'][number];
type AuditSchemaField = AuditSchemaModel['fields'][number];

const FORMAT_VERSION = 1;

const MISSING_SCHEMA_MESSAGE = [
  '[@prisma-audit] The "schema" option is missing. Add this generator block to schema.prisma:',
  '',
  'generator audit {',
  '  provider = "prisma-audit-generator"',
  '  output   = "../generated/audit"',
  '}',
  '',
  'then run `prisma generate` and pass `schema: auditSchema`, imported from that output.',
].join('\n');

const NOT_AN_AUDIT_SCHEMA_MESSAGE =
  '[@prisma-audit] The "schema" option has no numeric formatVersion, so it is not an audit schema. Pass the ' +
  "exported `auditSchema` itself, imported from the generator's output (`import { auditSchema } from " +
  "'<output>/index.js'`), not the module or an object that holds it.";

interface ModelMetadata {
  readonly uniqueConstraints: UniqueConstraint[];
  readonly relationFields: RelationField[];
  readonly fields: FieldMetadata[];
  readonly fieldsByName: ReadonlyMap<string, FieldMetadata>;
}

const fieldMetadataOf = (field: AuditSchemaField): FieldMetadata =>
  field.kind === 'object'
    ? {
        name: field.name,
        type: field.relatedModel,
        kind: field.kind,
        isRequired: field.isRequired,
        isUnique: false,
        isId: false,
        isList: field.isList,
        hasDefaultValue: false,
        isUpdatedAt: false,
      }
    : {
        name: field.name,
        type: field.type,
        kind: field.kind,
        isRequired: field.isRequired,
        isUnique: field.isUnique,
        isId: field.isId,
        isList: field.isList,
        hasDefaultValue: field.hasDefaultValue,
        isUpdatedAt: field.isUpdatedAt,
        ...(field.default ? { default: field.default } : {}),
      };

const relationFieldsOf = (model: AuditSchemaModel): RelationField[] =>
  model.fields.flatMap((field) =>
    field.kind === 'object'
      ? [
          {
            name: field.name,
            relatedModel: field.relatedModel,
            isList: field.isList,
            isRequired: field.isRequired,
            relationName: field.relationName,
            foreignKeyFields: [...field.foreignKeyFields],
            referencedFields: [...field.referencedFields],
          },
        ]
      : [],
  );

/** The primary key first, then the unique constraints in the order the schema lists them */
const uniqueConstraintsOf = (model: AuditSchemaModel): UniqueConstraint[] => [
  ...(model.primaryKey
    ? [{ type: 'primaryKey' as const, fields: [...model.primaryKey.fields], name: model.primaryKey.name }]
    : []),
  ...model.uniqueConstraints.map((constraint) => ({
    type: constraint.type,
    fields: [...constraint.fields],
    name: constraint.name,
  })),
];

const modelMetadataOf = (model: AuditSchemaModel): ModelMetadata => {
  const fields = model.fields.map(fieldMetadataOf);
  return {
    uniqueConstraints: uniqueConstraintsOf(model),
    relationFields: relationFieldsOf(model),
    fields,
    fieldsByName: new Map(fields.map((field) => [field.name, field])),
  };
};

const assertAuditSchema: (schema: unknown) => asserts schema is AuditSchema = (schema) => {
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(MISSING_SCHEMA_MESSAGE);
  }
  const formatVersion = 'formatVersion' in schema ? schema.formatVersion : undefined;
  if (typeof formatVersion !== 'number') {
    throw new Error(NOT_AN_AUDIT_SCHEMA_MESSAGE);
  }
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `[@prisma-audit] The "schema" option has formatVersion ${String(formatVersion)}; this version of ` +
        `@kuruwic/prisma-audit reads formatVersion ${FORMAT_VERSION}. Install the @kuruwic/prisma-audit-generator ` +
        'version that matches @kuruwic/prisma-audit and rerun `prisma generate`.',
    );
  }
};

/**
 * The {@link SchemaMetadata} of `schema`, the `auditSchema` the generator emits. Each model is
 * indexed once, here.
 *
 * @throws {Error} If `schema` is missing or not an object, has no numeric format version, or one this
 *   version of the extension does not read
 */
export const loadSchemaMetadata = (schema: unknown): SchemaMetadata => {
  assertAuditSchema(schema);

  const models = new Map(schema.models.map((model) => [model.name, modelMetadataOf(model)]));
  const modelNames = schema.models.map((model) => model.name);

  const findModel = (modelName: string): ModelMetadata => {
    const model = models.get(modelName);
    if (!model) {
      throw new Error(
        `[@prisma-audit] Model "${modelName}" is not in the audit schema passed as "schema"; pass the schema ` +
          'generated from the same schema.prisma as the client.',
      );
    }
    return model;
  };

  return {
    getModelNames: () => modelNames,
    getUniqueConstraints: (modelName) => findModel(modelName).uniqueConstraints,
    getRelationFields: (modelName) => findModel(modelName).relationFields,
    getAllFields: (modelName) => findModel(modelName).fields,
    getFieldMetadata: (modelName, fieldName) => findModel(modelName).fieldsByName.get(fieldName),
  };
};
