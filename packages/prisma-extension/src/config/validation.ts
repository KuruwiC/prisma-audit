/**
 * Configuration Validation
 *
 * Validates audit extension configuration for conflicts and ensures integrity
 * before extension initialization.
 *
 * @module config/validation
 */

import type { AggregateMapping } from '@kuruwic/prisma-audit-core';
import type { SecurityConfig } from '../types.js';

/**
 * Validates that fields don't appear in both excludeFields and redact.fields
 *
 * @throws {Error} If conflicting fields are found
 *
 * @remarks
 * Ensures fields are either excluded (not tracked) OR redacted (masked), never both.
 * Validates at global and model levels.
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
      if (entityConfig.excludeFields) {
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
