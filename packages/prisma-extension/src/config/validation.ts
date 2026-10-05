/**
 * Configuration Validation
 *
 * Validates audit extension configuration for conflicts and ensures integrity
 * before extension initialization.
 *
 * @module config/validation
 */

import type { AggregateMapping } from '@kuruwic/db-audit-core';
import type { SchemaMetadata } from '../schema/types.js';
import type { SecurityConfig } from '../types.js';

/**
 * Validates that no field is both excluded (`diffing.excludeFields` or an entity's `excludeFields`)
 * and redacted (`security.redact.fields`): a field is either untracked or masked, never both
 *
 * @throws {Error} If conflicting fields are found
 */
export const validateFieldConflicts = (
  excludeFields: string[],
  redact: SecurityConfig['redact'],
  aggregateMapping: AggregateMapping,
): void => {
  if (redact?.fields && excludeFields.length > 0) {
    const redactFieldsSet = new Set(redact.fields);
    const globalExcludeFieldsSet = new Set(excludeFields);

    const globalConflicts = [...redactFieldsSet].filter((field) => globalExcludeFieldsSet.has(field));
    if (globalConflicts.length > 0) {
      throw new Error(
        `Configuration error: Fields cannot be both in 'diffing.excludeFields' and 'security.redact.fields'. Conflicting fields: ${globalConflicts.join(
          ', ',
        )}. Please choose either to exclude (don't track changes) or redact (mask values).`,
      );
    }
  }

  if (redact?.fields) {
    const redactFieldsSet = new Set(redact.fields);
    for (const [modelName, entityConfig] of Object.entries(aggregateMapping)) {
      if (entityConfig?.excludeFields) {
        const modelExcludeFieldsSet = new Set(entityConfig.excludeFields);
        const modelConflicts = [...redactFieldsSet].filter((field) => modelExcludeFieldsSet.has(field));
        if (modelConflicts.length > 0) {
          throw new Error(
            `Configuration error for model '${modelName}': Fields cannot be both in entity 'excludeFields' and 'security.redact.fields'. Conflicting fields: ${modelConflicts.join(
              ', ',
            )}. Please choose either to exclude (don't track changes) or redact (mask values).`,
          );
        }
      }
    }
  }
};

const isColumn = (kind: string | undefined): boolean => kind === 'scalar' || kind === 'enum';

/**
 * Validates every entity's `auditOmittedFields`: each names a scalar or enum field of its model,
 * the only fields a client-level `omit` hides, and the client takes a query `omit`, which the
 * audit's own whole-row reads use to read them
 *
 * @param modelNames - The models of the schema, which mapping keys match case-insensitively
 * @throws {Error} If the client takes no query `omit`, the mapping key matches no model, or a listed
 *   field is not a column of the model
 */
export const validateAuditOmittedFields = (
  aggregateMapping: AggregateMapping,
  schemaMetadata: SchemaMetadata,
  modelNames: readonly string[],
  queryOmitSupported: boolean,
): void => {
  for (const [mappingKey, entityConfig] of Object.entries(aggregateMapping)) {
    const listed = entityConfig?.auditOmittedFields ?? [];
    if (listed.length === 0) {
      continue;
    }
    if (!queryOmitSupported) {
      throw new Error(
        `Configuration error for model '${mappingKey}': 'auditOmittedFields' needs Prisma 6.2 or later, ` +
          'whose queries take an omit; the Prisma version of this client is older or cannot be determined.',
      );
    }
    const modelName = modelNames.find((name) => name.toLowerCase() === mappingKey.toLowerCase());
    if (modelName === undefined) {
      throw new Error(
        `Configuration error for model '${mappingKey}': 'auditOmittedFields' is set on a mapping key that ` +
          'matches no model of the schema.',
      );
    }
    const notColumns = listed.filter((field) => !isColumn(schemaMetadata.getFieldMetadata(modelName, field)?.kind));
    if (notColumns.length > 0) {
      throw new Error(
        `Configuration error for model '${mappingKey}': 'auditOmittedFields' names fields that are not columns ` +
          `of the model: ${notColumns.join(', ')}. List the scalar or enum fields a client-level omit hides.`,
      );
    }
  }
};
