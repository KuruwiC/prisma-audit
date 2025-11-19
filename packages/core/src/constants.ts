/** Constants and Configuration Values for Audit Logging */

/** Action type for audit logging operations */
export type AuditAction = 'create' | 'update' | 'upsert' | 'delete' | 'createMany' | 'updateMany' | 'deleteMany';

/** Audit action type constants */
export const AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  UPSERT: 'upsert',
  DELETE: 'delete',
  CREATE_MANY: 'createMany',
  UPDATE_MANY: 'updateMany',
  DELETE_MANY: 'deleteMany',
} as const satisfies Record<string, AuditAction>;

/** Set of supported audit operations */
export const SUPPORTED_OPERATIONS: ReadonlySet<AuditAction> = new Set([
  AUDIT_ACTION.CREATE,
  AUDIT_ACTION.UPDATE,
  AUDIT_ACTION.UPSERT,
  AUDIT_ACTION.DELETE,
  AUDIT_ACTION.CREATE_MANY,
  AUDIT_ACTION.UPDATE_MANY,
  AUDIT_ACTION.DELETE_MANY,
]);

/** Timeout values for asynchronous enrichment operations (in milliseconds) */
export const ENRICHMENT_TIMEOUTS = {
  DEFAULT: 500,
  BATCH: 2000,
} as const;

/** Default configuration values for the audit extension */
export const DEFAULTS = {
  AUDIT_LOG_MODEL: 'AuditLog',
  SAMPLING: 1.0,
  AWAIT_WRITE: false,
  ID_FIELD: 'id',
} as const;
