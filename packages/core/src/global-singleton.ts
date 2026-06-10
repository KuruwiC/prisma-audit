/**
 * Returns a process-wide singleton, surviving dual-package loading (ESM + CJS
 * builds of this package would otherwise each get their own module instance,
 * splitting AsyncLocalStorage stores and pending-write registries).
 * @internal
 */
export const getGlobalSingleton = <T>(key: string, create: () => T): T => {
  const symbol = Symbol.for(`@kuruwic/prisma-audit:${key}`);
  const globals = globalThis as Record<symbol, unknown>;
  globals[symbol] ??= create();
  return globals[symbol] as T;
};
