/**
 * Where the foreign key of a relation lives
 *
 * A nested `connect`, `set` or `disconnect` changes the link between a parent row and its
 * related rows. Which row that link is a column of decides what the write changes: the related
 * rows' foreign key, the parent row's own foreign key, or rows of Prisma's join table.
 *
 * @module nested/pre-fetch/relation-link
 */

import type { NestedOperationInfo } from '../../grammar/nested-operations.js';
import type { RelationField, SchemaMetadata } from '../../schema/types.js';
import { findRelationField, resolveParentModelFromPath } from './coordinator.js';

/**
 * - `related`: the related model holds the foreign key `fields`, which reference the fields
 *   `references` of the parent model `parentModel` (in the same order); `optional` when a related
 *   row may hold no parent
 * - `parent`: the parent row holds the foreign key, so a link change is a change of the parent row
 * - `joinTable`: an implicit many-to-many relation, whose links are rows of a join table without a model
 */
export type RelationLink =
  | {
      readonly side: 'related';
      readonly parentModel: string;
      readonly fields: readonly string[];
      readonly references: readonly string[];
      readonly optional: boolean;
    }
  | { readonly side: 'parent' }
  | { readonly side: 'joinTable' };

/**
 * The field of the related model that points back along `field`'s relation. On a self-relation
 * `relatedFields` include `field` itself, which is not its own back-relation field.
 */
export const findBackRelationField = (
  field: RelationField,
  parentModelName: string,
  relatedModelName: string,
  relatedFields: readonly RelationField[],
): RelationField | undefined =>
  relatedFields.find(
    (candidate) =>
      candidate.relationName === field.relationName &&
      !(relatedModelName === parentModelName && candidate.name === field.name),
  );

export const resolveRelationLink = (
  field: RelationField,
  parentModelName: string,
  relatedModelName: string,
  relatedFields: readonly RelationField[],
): RelationLink | undefined => {
  if (field.foreignKeyFields.length > 0) {
    return { side: 'parent' };
  }
  const backField = findBackRelationField(field, parentModelName, relatedModelName, relatedFields);
  if (!backField) {
    return undefined;
  }
  if (backField.foreignKeyFields.length > 0) {
    return {
      side: 'related',
      parentModel: parentModelName,
      fields: backField.foreignKeyFields,
      references: backField.referencedFields,
      optional: !backField.isRequired,
    };
  }
  return backField.isList ? { side: 'joinTable' } : undefined;
};

/** The link of the relation the nested operation `operation` writes, below the top-level model `modelName` */
export const relationLinkOf = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operation: Pick<NestedOperationInfo, 'path' | 'fieldName' | 'relatedModel'>,
): RelationLink | undefined => {
  const parentModel = resolveParentModelFromPath(operation.path, modelName, schemaMetadata);
  const field = findRelationField(schemaMetadata, parentModel, operation.fieldName);
  if (!field) {
    return undefined;
  }
  return resolveRelationLink(
    field,
    parentModel,
    operation.relatedModel,
    schemaMetadata.getRelationFields(operation.relatedModel),
  );
};
