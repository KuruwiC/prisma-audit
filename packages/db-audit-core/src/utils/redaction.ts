import type { FieldChange } from './diff-calculator.js';
import { safeStringify } from './serialization.js';

/**
 * PII Redaction Utilities
 *
 * @module utils/redaction
 *
 * @remarks
 * Protects sensitive information in audit logs through field-level redaction.
 *
 * **Features:**
 * - Built-in sensitive field list (passwords, tokens, SSN, etc.), always redacted
 * - Structured redaction preserves metadata without exposing values
 * - Deep object traversal for nested fields
 * - Change detection via `isDifferent` flag
 *
 * @example
 * ```typescript
 * const redactor = createRedactor(['ssn']);
 *
 * redactor({ name: 'Alice', ssn: '123-45-6789' });
 * // => { name: 'Alice', ssn: { redacted: true, hadValue: true } }
 *
 * // Change tracking
 * const changes = { password: { old: 'oldPass', new: 'newPass' } };
 * redactor(changes);
 * // => { password: {
 * //      old: { redacted: true, hadValue: true },
 * //      new: { redacted: true, hadValue: true, isDifferent: true }
 * //    }}
 * ```
 */

const DEFAULT_SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'hashedPassword',
  'salt',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'secretKey',
  'privateKey',
  'ssn',
  'socialSecurityNumber',
  'creditCard',
  'cardNumber',
  'cvv',
  'pin',
];

/** Metadata stored in place of a redacted value, without exposing the value itself */
export interface RedactedFieldInfo {
  redacted: true;
  hadValue: boolean;
  /** Present in 'after' state for updates to indicate value changed */
  isDifferent?: boolean;
}

export type Redactor = (data: unknown) => unknown;

const isChangeObject = (value: unknown): value is { old: unknown; new: unknown } => {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'old' in value && 'new' in value;
};

const redactChangeObject = (changeObj: {
  old: unknown;
  new: unknown;
}): { old: RedactedFieldInfo | null; new: RedactedFieldInfo | null } => {
  const hadOldValue = changeObj.old != null;
  const hadNewValue = changeObj.new != null;
  const isDifferent = safeStringify(changeObj.old) !== safeStringify(changeObj.new);

  return {
    old: hadOldValue ? ({ redacted: true, hadValue: true } as RedactedFieldInfo) : null,
    new: hadNewValue ? ({ redacted: true, hadValue: true, isDifferent } as RedactedFieldInfo) : null,
  };
};

const redactSingleValue = (value: unknown): RedactedFieldInfo | null => {
  const hadValue = value != null;
  return hadValue ? ({ redacted: true, hadValue: true } as RedactedFieldInfo) : null;
};

/** Replaces the values of `fields` in a row with redaction metadata; top level only, unlike the deep redactor */
export const maskColumns = (row: Record<string, unknown>, fields: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, fields.has(key) ? redactSingleValue(value) : value]),
  );

export const maskChanges = (
  changes: Readonly<Record<string, FieldChange>>,
  fields: ReadonlySet<string>,
): Record<string, FieldChange> =>
  Object.fromEntries(
    Object.entries(changes).map(([key, change]) => [key, fields.has(key) ? redactChangeObject(change) : change]),
  );

const processObjectEntry = (
  key: string,
  value: unknown,
  sensitiveFields: Set<string>,
  redactData: (data: unknown) => unknown,
): unknown => {
  if (sensitiveFields.has(key)) {
    return isChangeObject(value) ? redactChangeObject(value) : redactSingleValue(value);
  }

  if (value !== null && typeof value === 'object') {
    return redactData(value);
  }

  return value;
};

/**
 * Create a redactor of the built-in sensitive fields and `fields`
 */
export const createRedactor = (fields: readonly string[] = []): Redactor => {
  const sensitiveFields = new Set([...DEFAULT_SENSITIVE_FIELDS, ...fields]);

  const redactArray = (arr: unknown[], redactData: (data: unknown) => unknown): unknown[] => {
    return arr.map((item) => redactData(item));
  };

  /**
   * Type guard for plain JavaScript objects ({} or Object.create(null))
   *
   * @remarks
   * Excludes built-in types (Date, RegExp, Error), class instances, arrays, and primitives
   */
  const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  const redactData = (data: unknown): unknown => {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    if (Array.isArray(data)) {
      return redactArray(data, redactData);
    }

    if (isPlainObject(data)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = processObjectEntry(key, value, sensitiveFields, redactData);
      }
      return result;
    }

    return data;
  };

  return redactData;
};

/**
 * Redact the built-in sensitive fields and `fields` of a state or a change set
 *
 * @remarks
 * Plain objects and arrays, the shape of serialized (JSON-safe) data, are walked and come back as
 * new containers; the input is never changed. Any other object is neither traversed nor copied.
 */
export const redactSensitiveData = (data: unknown, fields: readonly string[] = []): unknown =>
  createRedactor(fields)(data);
