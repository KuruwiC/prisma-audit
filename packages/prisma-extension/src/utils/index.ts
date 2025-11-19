/**
 * Utilities Module - Re-exports
 *
 * This module provides centralized access to all utility functions.
 *
 * @module utils
 */

// Extension utilities
export {
  extractDeleteOperationEntityId,
  isAuditableAction,
  shouldAuditModel,
  uncapitalizeFirst,
} from './extension-utils.js';

// ID generation
export { ensureIds } from './id-generator.js';

// Include injection
export { injectDeepInclude } from './include-injection.js';

// Model accessor
export { getModelAccessor } from './model-accessor.js';

// Operation classification
export {
  isBatchOperation,
  isSingleOperation,
  isWriteOperation,
  requiresBeforeState,
} from './operation-classifier.js';

// Schema metadata
export { getPrisma } from './schema-metadata.js';
