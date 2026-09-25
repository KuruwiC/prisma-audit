/**
 * Returns a process-wide singleton, surviving multiple copies of this package loaded
 * in one process (each copy would otherwise get its own module instance, splitting
 * AsyncLocalStorage stores and pending-write registries).
 * @internal
 */
export const getGlobalSingleton = <T>(key: string, create: () => T): T => {
  const symbol = Symbol.for(`@kuruwic/db-audit-core:${key}`);
  const globals = globalThis as Record<symbol, unknown>;
  globals[symbol] ??= create();
  return globals[symbol] as T;
};
