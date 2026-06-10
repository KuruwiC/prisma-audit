/** Constants and Configuration Values for Audit Logging */

/** Action type for audit logging operations */
export type AuditAction =
  | 'create'
  | 'update'
  | 'upsert'
  | 'delete'
  | 'createMany'
  | 'updateMany'
  | 'deleteMany'
  | 'createManyAndReturn'
  | 'updateManyAndReturn';

/** Audit action type constants */
export const AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  UPSERT: 'upsert',
  DELETE: 'delete',
  CREATE_MANY: 'createMany',
  UPDATE_MANY: 'updateMany',
  DELETE_MANY: 'deleteMany',
  CREATE_MANY_AND_RETURN: 'createManyAndReturn',
  UPDATE_MANY_AND_RETURN: 'updateManyAndReturn',
} as const satisfies Record<string, AuditAction>;

/** Single-record operations (processed one record at a time) */
export const SINGLE_OPERATIONS: ReadonlySet<AuditAction> = new Set([
  AUDIT_ACTION.CREATE,
  AUDIT_ACTION.UPDATE,
  AUDIT_ACTION.UPSERT,
  AUDIT_ACTION.DELETE,
]);

/**
 * Maps each batch operation to the singular action stored in the audit log.
 * `...AndReturn` normalizes to its create/update counterpart (no new DB action values).
 * This map's key set is the source of truth for "all batch operations".
 */
export const BATCH_TO_SINGULAR_ACTION = {
  [AUDIT_ACTION.CREATE_MANY]: AUDIT_ACTION.CREATE,
  [AUDIT_ACTION.UPDATE_MANY]: AUDIT_ACTION.UPDATE,
  [AUDIT_ACTION.DELETE_MANY]: AUDIT_ACTION.DELETE,
  [AUDIT_ACTION.CREATE_MANY_AND_RETURN]: AUDIT_ACTION.CREATE,
  [AUDIT_ACTION.UPDATE_MANY_AND_RETURN]: AUDIT_ACTION.UPDATE,
} as const satisfies Partial<Record<AuditAction, AuditAction>>;

/** Batch operation set (derived from BATCH_TO_SINGULAR_ACTION keys) */
export const BATCH_OPERATIONS: ReadonlySet<AuditAction> = new Set(
  Object.keys(BATCH_TO_SINGULAR_ACTION) as AuditAction[],
);

/** Set of supported audit operations (union of single and batch operations) */
export const SUPPORTED_OPERATIONS: ReadonlySet<AuditAction> = new Set([...SINGLE_OPERATIONS, ...BATCH_OPERATIONS]);

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
