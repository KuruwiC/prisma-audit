/**
 * Serialization Utilities for Audit Logging
 *
 * Converts JavaScript objects to JSON-compatible format for JSON column storage.
 * Handles non-JSON-serializable types: BigInt → string, and a value with a `toJSON` method (a
 * Date, a decimal.js `Decimal`, a Buffer) → what its `toJSON` returns.
 *
 * @example
 * ```typescript
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

const applyCustomSerializers = (
  value: unknown,
  serializers: readonly ValueSerializer[] | undefined,
): typeof UNHANDLED | unknown => {
  if (!serializers) return UNHANDLED;
  for (const serializer of serializers) {
    const result = serializer(value);
    if (result !== UNHANDLED) return result;
  }
  return UNHANDLED;
};

const hasToJSON = (value: object): value is { toJSON: () => unknown } =>
  typeof (value as { toJSON?: unknown }).toJSON === 'function';

const serializeObjectEntries = (
  obj: object,
  serializers: readonly ValueSerializer[] | undefined,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = serializeForAuditJson(value, serializers);
  }
  return result;
};

/**
 * Recursively serialize non-JSON-safe values for audit log JSON column storage
 *
 * Built-in conversions:
 * - `BigInt` → `string` (e.g. `123n` → `"123"`)
 * - an object with a `toJSON` method → what `toJSON` returns, serialized, as `JSON.stringify`
 *   does: a `Date` → its ISO string (`"2025-01-01T00:00:00.000Z"`, `null` for an invalid date),
 *   a decimal.js `Decimal` → its string (`"1.5"`), a `Buffer` → `{ type: 'Buffer', data: [...] }`.
 *   `toJSON` is called once per value: its result is not passed to its own `toJSON`
 * - arrays → each element serialized
 * - any other object → a plain object of its own enumerable properties, each serialized (a `Map`
 *   or `Set` without a custom serializer becomes `{}`)
 *
 * Custom serializers run before built-ins and can override any conversion, `toJSON` included.
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
export const serializeForAuditJson = (obj: unknown, serializers?: readonly ValueSerializer[]): unknown =>
  serializeValue(obj, serializers, true);

const serializeValue = (
  value: unknown,
  serializers: readonly ValueSerializer[] | undefined,
  callToJSON: boolean,
): unknown => {
  const customResult = applyCustomSerializers(value, serializers);
  if (customResult !== UNHANDLED) return customResult;

  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (callToJSON && hasToJSON(value)) return serializeValue(value.toJSON(), serializers, false);
  if (Array.isArray(value)) return value.map((item) => serializeForAuditJson(item, serializers));
  return serializeObjectEntries(value, serializers);
};
