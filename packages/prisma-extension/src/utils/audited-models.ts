/**
 * Audited models a write writes
 *
 * The input of the audit gate, read from the arguments the operation runs with. Every branch of
 * every upsert and connectOrCreate is scanned, since which one runs is not known before the
 * operation.
 *
 * @module utils/audited-models
 */

import {
  detectNestedOperations,
  type NestedOperationInfo,
  nestedValueWritesRows,
} from '../grammar/nested-operations.js';
import { relationLinkOf } from '../nested/pre-fetch/relation-link.js';
import type { SchemaMetadata } from '../schema/types.js';
import { isRecord } from './is-record.js';

/** The nested keywords that change only the link between the parent row and existing related rows */
const LINK_KEYWORDS: ReadonlySet<string> = new Set(['connect', 'set', 'disconnect']);

/**
 * Whether a nested operation writes rows of its related model. A link change writes them only
 * when they hold the foreign key: when the parent row holds it, the parent row is written, and an
 * implicit many-to-many relation writes rows of its join table only. A relation whose foreign key
 * cannot be placed counts as writing them.
 */
const writesRelatedRows = (schemaMetadata: SchemaMetadata, modelName: string, operation: NestedOperationInfo) => {
  if (!nestedValueWritesRows(operation.operation, operation.data)) {
    return false;
  }
  if (!LINK_KEYWORDS.has(operation.operation)) {
    return true;
  }
  const side = relationLinkOf(schemaMetadata, modelName, operation)?.side;
  return side !== 'parent' && side !== 'joinTable';
};

/**
 * The audited models whose rows an operation on `modelName` with `args` writes, its own model
 * first, then the models of its nested writes in the order they are found, each once
 */
export const auditedModelsWrittenBy = (
  schemaMetadata: SchemaMetadata,
  shouldAudit: (modelName: string) => boolean,
  modelName: string,
  args: unknown,
): string[] => {
  const nested = isRecord(args)
    ? detectNestedOperations(schemaMetadata, modelName, args, { kind: 'discovery' })
        .filter((operation) => writesRelatedRows(schemaMetadata, modelName, operation))
        .map((operation) => operation.relatedModel)
    : [];
  return [...new Set([modelName, ...nested])].filter(shouldAudit);
};
