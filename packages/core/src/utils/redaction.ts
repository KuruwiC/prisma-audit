/**
 * PII Redaction Utilities
 *
 * @module redaction
 *
 * @remarks
 * Protects sensitive information in audit logs through field-level redaction.
 *
 * **Features:**
 * - Default sensitive field list (passwords, tokens, SSN, etc.)
 * - Structured redaction preserves metadata without exposing values
 * - Deep object traversal for nested fields
 * - Change detection via `isDifferent` flag
 *
 * @example
 * ```typescript
 * const redactor = createRedactor({ fields: ['ssn'] });
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

/**
 * Redacted field metadata
 *
 * @remarks
 * Provides information about redacted fields without exposing actual values
 */
export interface RedactedFieldInfo {
  redacted: true;
  hadValue: boolean;
  /** Present in 'after' state for updates to indicate value changed */
  isDifferent?: boolean;
}

export type RedactMaskFn = (field: string, value: unknown) => unknown;

export interface RedactConfig {
  fields?: string[];
}

export type Redactor = (data: unknown) => unknown;

/** @internal */
const isChangeObject = (value: unknown): value is { old: unknown; new: unknown } => {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'old' in value && 'new' in value;
};

/** @internal */
const redactChangeObject = (changeObj: {
  old: unknown;
  new: unknown;
}): { old: RedactedFieldInfo | null; new: RedactedFieldInfo | null } => {
  const hadOldValue = changeObj.old != null;
  const hadNewValue = changeObj.new != null;
  const isDifferent = JSON.stringify(changeObj.old) !== JSON.stringify(changeObj.new);

  return {
    old: hadOldValue ? ({ redacted: true, hadValue: true } as RedactedFieldInfo) : null,
    new: hadNewValue ? ({ redacted: true, hadValue: true, isDifferent } as RedactedFieldInfo) : null,
  };
};

/** @internal */
const redactSingleValue = (value: unknown): RedactedFieldInfo | null => {
  const hadValue = value != null;
  return hadValue ? ({ redacted: true, hadValue: true } as RedactedFieldInfo) : null;
};

/** @internal */
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
 * Create a redactor function with the specified configuration
 */
export const createRedactor = (config: RedactConfig = {}): Redactor => {
  const sensitiveFields = new Set([...DEFAULT_SENSITIVE_FIELDS, ...(config.fields || [])]);

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
 * Deep clone and redact data
 *
 * @remarks
 * Uses structuredClone (Node.js 17+) with JSON fallback if clone fails
 */
export const redactSensitiveData = (data: unknown, config: RedactConfig = {}): unknown => {
  if (data === null || data === undefined) {
    return data;
  }

  let cloned: unknown;
  try {
    cloned = structuredClone(data);
  } catch (error) {
    console.warn(
      '[@prisma-audit] Failed to clone data for redaction using structuredClone. Using JSON fallback.',
      error instanceof Error ? error.message : String(error),
    );

    try {
      cloned = JSON.parse(JSON.stringify(data));
    } catch {
      console.warn('[@prisma-audit] Cannot clone data for redaction. Redaction skipped.');
      return data;
    }
  }

  const redactor = createRedactor(config);
  return redactor(cloned);
};

/**
 * Check if a field name is sensitive
 */
export const isSensitiveField = (fieldName: string, additionalFields: string[] = []): boolean => {
  const allSensitiveFields = new Set([...DEFAULT_SENSITIVE_FIELDS, ...additionalFields]);
  return allSensitiveFields.has(fieldName);
};

/**
 * Get list of default sensitive fields
 */
export const getDefaultSensitiveFields = (): readonly string[] => {
  return DEFAULT_SENSITIVE_FIELDS;
};
