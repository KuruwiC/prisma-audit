/**
 * Serialization Utilities for Audit Logging
 *
 * Converts JavaScript objects to JSON-compatible format for Prisma JSONB storage.
 * Handles non-JSON-serializable types: BigInt → string, Date → ISO string.
 *
 * @example
 * ```typescript
 * // BigInt and Date serialization
 * serializeForAuditJson({ balance: 100n, createdAt: new Date('2025-01-01') });
 * // => { balance: '100', createdAt: '2025-01-01T00:00:00.000Z' }
 *
 * // Safe JSON.stringify for BigInt-containing objects
 * safeStringify({ id: 123n, name: 'test' });
 * // => '{"id":"123","name":"test"}'
 * ```
 */

/**
 * Sentinel value returned by custom serializers to indicate the value is not handled.
 *
 * @example
 * ```typescript
 * const mySerializer: ValueSerializer = (value) => {
 *   if (value instanceof Buffer) return value.toString('base64');
 *   return UNHANDLED;
 * };
 * ```
 */
export const UNHANDLED: unique symbol = Symbol('UNHANDLED');

/**
 * Custom value serializer function.
 *
 * Return the serialized value, or `UNHANDLED` to delegate to the next serializer / built-in logic.
 *
 * The returned value MUST be JSON-safe (no BigInt, Date, etc.). If your serializer returns
 * a container with nested non-JSON-safe values, call `serializeForAuditJson` within the serializer.
 */
export type ValueSerializer = (value: unknown) => unknown | typeof UNHANDLED;

/**
 * JSON.stringify with BigInt support
 *
 * @remarks
 * Standard JSON.stringify throws on BigInt values. This helper uses a replacer
 * to convert BigInt to string, making it safe for any data that may contain BigInt.
 * Returns `undefined` when the input is `undefined`, a function, or a Symbol
 * (same behavior as `JSON.stringify`).
 */
export const safeStringify = (value: unknown): string | undefined => {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (Array.isArray(value) || value instanceof Date) {
    return false;
  }

  return true;
};

const applyCustomSerializers = (
  value: unknown,
  serializers: ValueSerializer[] | undefined,
): typeof UNHANDLED | unknown => {
  if (!serializers) return UNHANDLED;
  for (const serializer of serializers) {
    const result = serializer(value);
    if (result !== UNHANDLED) return result;
  }
  return UNHANDLED;
};

const serializeObjectEntries = (
  obj: Record<string, unknown>,
  customSerializers: ValueSerializer[] | undefined,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.hasOwn(obj, key)) {
      result[key] = serializeForAuditJson(obj[key], customSerializers);
    }
  }
  return result;
};

/**
 * Recursively serialize non-JSON-safe values for audit log JSONB storage
 *
 * Built-in conversions:
 * - `BigInt` → `string` (e.g. `123n` → `"123"`)
 * - `Date` → ISO string (e.g. `new Date(...)` → `"2025-01-01T00:00:00.000Z"`)
 *
 * Custom serializers run before built-ins and can override any conversion.
 * Return `UNHANDLED` from a custom serializer to fall through to the next.
 *
 * @example
 * ```typescript
 * serializeForAuditJson({ balance: 100n, createdAt: new Date('2025-01-01') });
 * // => { balance: '100', createdAt: '2025-01-01T00:00:00.000Z' }
 *
 * // With custom serializer for Buffer
 * const bufferSerializer: ValueSerializer = (v) =>
 *   v instanceof Buffer ? v.toString('base64') : UNHANDLED;
 * serializeForAuditJson({ data: Buffer.from('hello') }, [bufferSerializer]);
 * // => { data: 'aGVsbG8=' }
 * ```
 */
export const serializeForAuditJson = (obj: unknown, customSerializers?: ValueSerializer[]): unknown => {
  const customResult = applyCustomSerializers(obj, customSerializers);
  if (customResult !== UNHANDLED) return customResult;

  if (typeof obj === 'bigint') return obj.toString();
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map((item) => serializeForAuditJson(item, customSerializers));
  if (isPlainObject(obj)) return serializeObjectEntries(obj, customSerializers);

  return obj;
};
