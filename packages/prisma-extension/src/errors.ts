/**
 * Errors the audited client throws itself
 *
 * @module errors
 */

/**
 * Thrown by `$transaction` when its callback resolved although an audit failure had failed one of
 * its operations once that operation's write had run (a failed immediate audit write, a failed
 * build of the records inside the transaction). The transaction rolls back, so the write never
 * commits without its audit rows, even when the callback caught the operation's error. `cause` is
 * the first such audit failure.
 */
export class AuditRollbackError extends Error {
  constructor(cause: Error) {
    super(
      `The transaction was rolled back: an audit failure failed one of its operations, and the callback resolved all the same (${cause.message})`,
      { cause },
    );
    this.name = 'AuditRollbackError';
  }
}

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
