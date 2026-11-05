/** Calls the method named `method` of `owner`, a Prisma client or what one of its calls returned */
export const invokeMethod = (owner: unknown, method: string, args: readonly unknown[]): unknown => {
  const fn: unknown =
    (typeof owner === 'object' || typeof owner === 'function') && owner !== null
      ? Reflect.get(owner, method)
      : undefined;
  if (typeof fn !== 'function') {
    throw new Error(`Client method "${method}" not found`);
  }
  return Reflect.apply(fn, owner, args);
};
