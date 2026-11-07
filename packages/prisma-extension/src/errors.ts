/**
 * Errors the audited client throws itself
 *
 * @module errors
 */

import { RejectedWriteError } from '@kuruwic/db-audit-core';

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

/**
 * Thrown before a write runs when it is issued through a client below the audit: the client passed
 * to `createAuditClient` and the clients under it as `$parent` leads to them from the audited
 * client, inside a transaction their transaction clients, a `$transaction` opened on one, or a
 * client `$extends` derives from one. The `$parent` of a client `$extends` derives from the audited
 * client is not below the audit.
 *
 * Such a client runs the extensions applied before the audit, which may change a write's arguments
 * in ways the audit cannot see, so every model write through it is rejected, of an audited model or
 * not, while the audit processes an operation too, and so is a batch `$transaction([...])` that
 * holds one, before any of its operations runs; its reads and raw queries run. The rejection is
 * decided when the write starts, from the client and the action alone, never from the arguments,
 * and the write has no outcome.
 */
export class AuditParentWriteError extends RejectedWriteError {
  constructor({ modelName, operation }: { readonly modelName: string; readonly operation: string }) {
    super(
      `A write to ${modelName} was rejected: it was issued through a client below the audit (reached through $parent), which runs extensions the audit cannot see, so every write through it is rejected. Apply the extension that writes after the audit (createAuditClient(prisma).$extends(extension)), or write through Prisma.getExtensionContext(this) or the audited client; to write unaudited on purpose, use the client the application holds itself (operation ${operation} on ${modelName})`,
      { modelName, operationModelName: modelName, operation },
    );
    this.name = 'AuditParentWriteError';
  }
}
