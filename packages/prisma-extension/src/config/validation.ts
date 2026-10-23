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
import type { WriteConfig } from '../types.js';

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

/**
 * Validates that `write.implicitTransaction` is not set with `write.awaited: false`: the implicit
 * transaction is opened only around an operation whose audit is awaited, so none would get one.
 * A function `awaited` is not checked, since it may await some models.
 *
 * @throws {Error} If `write.implicitTransaction` is true and `write.awaited` is false
 */
export const validateImplicitTransaction = (write: WriteConfig | undefined): void => {
  if (write?.implicitTransaction === true && write.awaited === false) {
    throw new Error(
      "Configuration error: 'write.implicitTransaction' opens a transaction only around an operation whose audit is " +
        "awaited, and 'write.awaited' is false, so no operation would get one. Remove 'write.implicitTransaction', or " +
        "set 'write.awaited' to true or to a function.",
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
