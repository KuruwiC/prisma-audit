/**
 * Whether Prisma `prismaVersion` opens a `$transaction` on the client a `$transaction` callback
 * receives, nested in that transaction as a savepoint: Prisma 7.5 and later. Earlier versions have
 * no `$transaction` on that client.
 */
export const opensNestedTransactions = (prismaVersion: string): boolean => {
  const [major = 0, minor = 0] = prismaVersion.split('.').map((part) => Number.parseInt(part, 10));
  return major > 7 || (major === 7 && minor >= 5);
};
