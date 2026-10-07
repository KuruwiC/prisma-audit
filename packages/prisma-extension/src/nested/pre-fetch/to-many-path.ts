/**
 * The relation a to-many nested path goes through: the model it hangs under, the primary keys on
 * both sides, and how a related row is scoped to its parent row.
 *
 * @module nested/pre-fetch/to-many-path
 */

import { getPrimaryKeyConstraint, type NestedOperationInfo } from '../../grammar/nested-operations.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { preFetchLog } from '../../utils/debug.js';
import { findRelationField, resolveParentModelFromPath } from './coordinator.js';
import { resolveToManyRelationScope, type ToManyRelationScope } from './one-to-many-fetcher.js';

export interface ToManyPath {
  readonly parentModelName: string;
  readonly parentPk: UniqueConstraint;
  readonly pk: UniqueConstraint;
  readonly scope: ToManyRelationScope;
}

/** `modelName` is the top-level model; undefined when the schema has no such field or a side has no primary key */
export const resolveToManyPath = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operation: Pick<NestedOperationInfo, 'path' | 'fieldName' | 'relatedModel'>,
): ToManyPath | undefined => {
  const parentModel = resolveParentModelFromPath(operation.path, modelName, schemaMetadata);
  const field = findRelationField(schemaMetadata, parentModel, operation.fieldName);
  if (!field) {
    preFetchLog('to-many path: field not found in model: field=%s path=%s', operation.fieldName, operation.path);
    return undefined;
  }

  const parentPk = getPrimaryKeyConstraint(schemaMetadata, parentModel);
  const pk = getPrimaryKeyConstraint(schemaMetadata, operation.relatedModel);
  if (!parentPk || !pk) {
    preFetchLog('to-many path: no primary key: model=%s path=%s', operation.relatedModel, operation.path);
    return undefined;
  }

  return {
    parentModelName: parentModel,
    parentPk,
    pk,
    scope: resolveToManyRelationScope(schemaMetadata, field, parentModel, parentPk.fields),
  };
};
