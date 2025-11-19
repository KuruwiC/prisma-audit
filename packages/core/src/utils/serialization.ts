/**
 * Serialization Utilities for Audit Logging
 *
 * Converts JavaScript objects to Prisma-compatible JSON format.
 * Required because Prisma's JSON serializer doesn't call `.toJSON()` on Date objects,
 * causing them to be stored as empty objects `{}` in JSONB fields.
 *
 * @example
 * ```typescript
 * // Without serialization: Dates stored as {}
 * await prisma.auditLog.create({
 *   data: { before: { createdAt: new Date('2025-01-01') } }
 * });
 * // Stored: { "before": { "createdAt": {} } }  ❌
 *
 * // With serialization: Dates stored as ISO strings
 * await prisma.auditLog.create({
 *   data: { before: convertDatesToISOStrings({ createdAt: new Date('2025-01-01') }) }
 * });
 * // Stored: { "before": { "createdAt": "2025-01-01T00:00:00.000Z" } }  ✅
 * ```
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (Array.isArray(value) || value instanceof Date) {
    return false;
  }

  return true;
};

/**
 * Recursively convert Date objects to ISO strings for Prisma JSON fields
 *
 * @example
 * ```typescript
 * convertDatesToISOStrings(new Date('2025-01-01'));
 * // => '2025-01-01T00:00:00.000Z'
 *
 * convertDatesToISOStrings({
 *   id: '123',
 *   createdAt: new Date('2025-01-01'),
 *   nested: { updatedAt: new Date('2025-01-02') }
 * });
 * // => {
 * //   id: '123',
 * //   createdAt: '2025-01-01T00:00:00.000Z',
 * //   nested: { updatedAt: '2025-01-02T00:00:00.000Z' }
 * // }
 * ```
 */
export const convertDatesToISOStrings = (obj: unknown): unknown => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => convertDatesToISOStrings(item));
  }

  if (isPlainObject(obj)) {
    const convertedObj: Record<string, unknown> = {};
    for (const key in obj) {
      if (Object.hasOwn(obj, key)) {
        convertedObj[key] = convertDatesToISOStrings(obj[key]);
      }
    }
    return convertedObj;
  }

  return obj;
};
