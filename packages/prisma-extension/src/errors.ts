/**
 * Errors the audited client throws itself
 *
 * @module errors
 */

/**
 * Thrown before an audited write runs when it reaches the audit without the binding the client it
 * was issued on gives it, as a write Prisma runs as part of its own batch `$transaction([...])`
 * would: no audit read or write could join it, so it is not run unaudited.
 */
export class AuditUnboundWriteError extends Error {
  readonly modelName: string;
  readonly operation: string;

  constructor({ modelName, operation }: { readonly modelName: string; readonly operation: string }) {
    super(
      `An audited ${operation} on ${modelName} was rejected: it reached the audit without the client it was issued on, as an operation of a batch $transaction([...]) Prisma runs itself does`,
    );
    this.name = 'AuditUnboundWriteError';
    this.modelName = modelName;
    this.operation = operation;
  }
}
