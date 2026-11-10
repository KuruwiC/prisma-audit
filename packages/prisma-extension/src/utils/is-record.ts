export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `value` is an object literal or `Object.create(null)`, not an instance of a class */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
