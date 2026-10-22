/** A value on which `instanceof` throws (a proxy whose `getPrototypeOf` trap throws) is not an Error. */
const isError = (value: unknown): value is Error => {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
};

/** Never throws, because callers run it inside a catch, even when `String()` or `instanceof` throws on the value. */
export const toError = (caught: unknown): Error => {
  if (isError(caught)) {
    return caught;
  }
  try {
    return new Error(String(caught), { cause: caught });
  } catch {
    return new Error('Thrown value could not be converted to a string', { cause: caught });
  }
};
