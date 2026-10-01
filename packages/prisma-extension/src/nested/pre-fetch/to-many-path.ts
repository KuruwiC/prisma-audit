/**
 * The relation a to-many nested path goes through: the model it hangs under, the primary keys on
 * both sides, and how a related row is scoped to its parent row.
 *
 * @module nested/pre-fetch/to-many-path
 */

import { getPrimaryKeyConstraint, type NestedOperationInfo } from '../../grammar/nested-operations.js';
import type { PrismaNamespace } from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { preFetchLog } from '../../utils/debug.js';
import { findDMMFField, resolveParentModelFromPath } from './coordinator.js';
import { resolveToManyRelationScope, type ToManyRelationScope } from './one-to-many-fetcher.js';

export interface ToManyPath {
  readonly parentModelName: string;
  readonly parentPk: UniqueConstraint;
  readonly pk: UniqueConstraint;
  readonly scope: ToManyRelationScope;
}

/**
 * Resolves the relation of the to-many path `operation` writes at, below the top-level model
 * `modelName`; undefined when the DMMF has no such field or a side has no primary key.
 */
export const resolveToManyPath = (
  Prisma: PrismaNamespace,
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operation: Pick<NestedOperationInfo, 'path' | 'fieldName' | 'relatedModel'>,
): ToManyPath | undefined => {
  const { dmmf } = Prisma;
  const topLevelModel = dmmf.datamodel.models.find((model) => model.name === modelName);
  const parentModel = resolveParentModelFromPath(operation.path, topLevelModel, dmmf);
  const field = findDMMFField(parentModel, operation.fieldName);
  if (!parentModel || !field) {
    preFetchLog('to-many path: field not found in model: field=%s path=%s', operation.fieldName, operation.path);
    return undefined;
  }

  const parentPk = getPrimaryKeyConstraint(schemaMetadata, parentModel.name);
  const pk = getPrimaryKeyConstraint(schemaMetadata, operation.relatedModel);
  if (!parentPk || !pk) {
    preFetchLog('to-many path: no primary key: model=%s path=%s', operation.relatedModel, operation.path);
    return undefined;
  }

  const relatedModel = dmmf.datamodel.models.find((model) => model.name === operation.relatedModel);
  return {
    parentModelName: parentModel.name,
    parentPk,
    pk,
    scope: resolveToManyRelationScope(field, parentModel.name, relatedModel, parentPk.fields),
  };
};
