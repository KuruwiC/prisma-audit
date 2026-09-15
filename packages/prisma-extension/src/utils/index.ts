/**
 * Utilities Module - Re-exports
 *
 * This module provides centralized access to all utility functions.
 *
 * @module utils
 */

// Caller-mutation error tagging
export { isCallerMutationError, runCallerMutation } from './caller-mutation-error.js';

// Extension utilities
export { isAuditableAction, shouldAuditModel, uncapitalizeFirst } from './extension-utils.js';

// ID generation and primary key utilities
export { buildEntityMap, ensureIds, extractPrimaryKey, findManyByPKs, getPrimaryKeyFields } from './id-generator.js';

// Nested-write selection injection
export { injectNestedWriteSelection, projectToRequestedShape } from './include-injection.js';

// Model accessor
export { getModelAccessor } from './model-accessor.js';

// Operation classification
export { isBatchOperation, requiresBeforeState } from './operation-classifier.js';
