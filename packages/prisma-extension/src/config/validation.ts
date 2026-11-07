/**
 * Configuration Validation
 *
 * Validates audit extension configuration for conflicts and ensures integrity
 * before extension initialization.
 *
 * @module config/validation
 */

import type { EntityMap } from '@kuruwic/db-audit-core';
import type { SchemaMetadata } from '../schema/types.js';

/**
 * Validates that no field is both excluded from the diff (`diffExcludeFields`, global or an
 * entity's) and named in `redactFields`: a field is listed in one or the other
 *
 * @throws {Error} If conflicting fields are found
 */
export const validateFieldConflicts = (
  diffExcludeFields: readonly string[],
  redactFields: readonly string[],
  entities: EntityMap,
): void => {
  if (redactFields.length === 0) {
    return;
  }
  const redactFieldsSet = new Set(redactFields);

  const globalConflicts = diffExcludeFields.filter((field) => redactFieldsSet.has(field));
  if (globalConflicts.length > 0) {
    throw new Error(
      `Configuration error: Fields cannot be both in 'diffExcludeFields' and 'redactFields'. Conflicting fields: ${globalConflicts.join(
        ', ',
      )}. Please choose either to exclude (don't track changes) or redact (mask values).`,
    );
  }

  for (const [modelName, entityConfig] of Object.entries(entities)) {
    const modelConflicts = (entityConfig?.diffExcludeFields ?? []).filter((field) => redactFieldsSet.has(field));
    if (modelConflicts.length > 0) {
      throw new Error(
        `Configuration error for model '${modelName}': Fields cannot be both in entity 'diffExcludeFields' and 'redactFields'. Conflicting fields: ${modelConflicts.join(
          ', ',
        )}. Please choose either to exclude (don't track changes) or redact (mask values).`,
      );
    }
  }
};

/** A model the audit rows are written to, and the option that names it */
export interface AuditRowDestination {
  readonly modelName: string;
  readonly source: 'write.model' | 'write.writer';
}

/**
 * Validates that the entity map lists no model the audit rows are written to: the audit's own
 * write to one would be issued while the audit processes an operation, and the audit gate rejects
 * such a write of an audited model, so every record would be lost, outside a transaction without
 * failing the write
 *
 * @param isAudited - Whether the entity map lists a model (model name case-insensitive)
 * @throws {Error} If the entity map lists one of `destinations`
 */
export const validateAuditRowDestinations = (
  destinations: readonly AuditRowDestination[],
  isAudited: (modelName: string) => boolean,
): void => {
  const audited = destinations.find(({ modelName }) => isAudited(modelName));
  if (audited !== undefined) {
    throw new Error(
      `Configuration error: 'entities' lists ${audited.modelName}, which the audit rows are written to (${audited.source}). ` +
        "The audit's own write to it would be rejected as a write issued while the audit processes an operation, " +
        `losing the records of every audited write. Remove ${audited.modelName} from 'entities'.`,
    );
  }
};

const isColumn = (kind: string | undefined): boolean => kind === 'scalar' || kind === 'enum';

/**
 * Validates every entity's `recordOmittedFields`: each names a scalar or enum field of its model,
 * the only fields a client-level `omit` hides, and the client takes a query `omit`, which the
 * audit's own whole-row reads use to read them
 *
 * @param modelNames - The models of the schema, which entity map keys match case-insensitively
 * @throws {Error} If the client takes no query `omit`, the entity map key matches no model, or a listed
 *   field is not a column of the model
 */
export const validateRecordOmittedFields = (
  entities: EntityMap,
  schemaMetadata: SchemaMetadata,
  modelNames: readonly string[],
  queryOmitSupported: boolean,
): void => {
  for (const [entityKey, entityConfig] of Object.entries(entities)) {
    const listed = entityConfig?.recordOmittedFields ?? [];
    if (listed.length === 0) {
      continue;
    }
    if (!queryOmitSupported) {
      throw new Error(
        `Configuration error for model '${entityKey}': 'recordOmittedFields' needs Prisma 6.2 or later, ` +
          'whose queries take an omit; the Prisma version of this client is older or cannot be determined.',
      );
    }
    const modelName = modelNames.find((name) => name.toLowerCase() === entityKey.toLowerCase());
    if (modelName === undefined) {
      throw new Error(
        `Configuration error for model '${entityKey}': 'recordOmittedFields' is set on an entity map key that ` +
          'matches no model of the schema.',
      );
    }
    const notColumns = listed.filter((field) => !isColumn(schemaMetadata.getFieldMetadata(modelName, field)?.kind));
    if (notColumns.length > 0) {
      throw new Error(
        `Configuration error for model '${entityKey}': 'recordOmittedFields' names fields that are not columns ` +
          `of the model: ${notColumns.join(', ')}. List the scalar or enum fields a client-level omit hides.`,
      );
    }
  }
};
