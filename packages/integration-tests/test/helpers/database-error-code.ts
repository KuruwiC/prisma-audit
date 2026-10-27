/**
 * The database's own error code on a Prisma known request error
 *
 * Prisma 7 runs queries through the driver adapter in the client and keeps the adapter's error at
 * `meta.driverAdapterError`, whose `cause.originalCode` is the database's code (a PostgreSQL
 * SQLSTATE, a MySQL errno). Prisma 6 maps the error in its query engine and keeps only the Prisma
 * code: the database's code is not on the error.
 */

interface KnownRequestError {
  readonly code: string;
  readonly meta?: Record<string, unknown> | undefined;
}

export const databaseCodeOf = (error: KnownRequestError): unknown => {
  const driverAdapterError: unknown = error.meta?.driverAdapterError;
  const cause: unknown =
    typeof driverAdapterError === 'object' && driverAdapterError !== null
      ? Reflect.get(driverAdapterError, 'cause')
      : undefined;
  return typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'originalCode') : undefined;
};

/** What {@link databaseCodeOf} returns, on Prisma `prismaVersion`, for a failure whose database code is `code` */
export const carriedDatabaseCode = (prismaVersion: string, code: string): string | undefined =>
  Number.parseInt(prismaVersion, 10) >= 7 ? code : undefined;
