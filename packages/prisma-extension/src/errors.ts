/**
 * Errors the audited client throws itself
 *
 * @module errors
 */

import { RejectedWriteError } from '@kuruwic/db-audit-core';

/**
 * Thrown before a write runs when it reaches the audit without the binding the client it was
 * issued on gives it, as an audited write Prisma runs as part of its own batch `$transaction([...])`
 * would: no audit read or write could join it, so it is not run unaudited. Thrown as well before a
 * model write runs when it reaches the checkpoint after a query extension applied after the audit
 * without the audit continuing it, so that the audit could not compare what it records with what
 * runs.
 */
export class AuditUnboundWriteError extends Error {
  readonly modelName: string;
  readonly operation: string;

  constructor({ modelName, operation }: { readonly modelName: string; readonly operation: string }) {
    super(
      `A ${operation} on ${modelName} was rejected: it reached the audit without the client it was issued on, as an operation of a batch $transaction([...]) Prisma runs itself does, or it reached a query extension applied after the audit without the audit continuing it`,
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
      `A write to ${modelName} was rejected: it was issued through a client below the audit (reached through $parent), which runs extensions the audit cannot see, so every write through it is rejected. Write through Prisma.getExtensionContext(this) or the audited client instead, or apply a method that writes through $parent to the audited client (createAuditClient(prisma).$extends(extension)); to write unaudited on purpose, use the client the application holds itself (operation ${operation} on ${modelName})`,
      { modelName, operationModelName: modelName, operation },
    );
    this.name = 'AuditParentWriteError';
  }
}

/**
 * How a query extension applied after the audit broke the rule for continuing a model write. `structure` lists the
 * locations in the arguments (`posts.create`, `update.posts.create`; `data` for the rows of a
 * top-level createMany) whose nested writes, row count or order differ; `not-continued`: the write
 * settled without running; `continued-twice`: `query` was called again once the write ran or while
 * it runs; `continued-after-settling`: `query` was called once the write had settled.
 */
export type AuditContinuationViolation =
  | {
      readonly kind: 'structure';
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
    }
  | { readonly kind: 'not-continued' }
  | { readonly kind: 'continued-twice' }
  | { readonly kind: 'continued-after-settling' };

const describeViolation = (violation: AuditContinuationViolation): string => {
  switch (violation.kind) {
    case 'structure': {
      const parts = [
        ['added', violation.added],
        ['removed', violation.removed],
        ['changed', violation.changed],
      ] as const;
      return `it changed the nested writes the arguments hold (${parts
        .filter(([, locations]) => locations.length > 0)
        .map(([label, locations]) => `${label}: ${locations.join(', ')}`)
        .join('; ')})`;
    }
    case 'not-continued':
      return 'it settled without the operation having run through query';
    case 'continued-twice':
      return 'it called query again once the operation had run or while it ran, which would run another write';
    case 'continued-after-settling':
      return 'it called query once the operation had settled';
    default: {
      const exhaustiveCheck: never = violation;
      throw new Error(`[@prisma-audit] Unhandled continuation violation: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * Thrown for a query extension applied after the audit (`createAuditClient(prisma).$extends(extension)`)
 * that changes which relations a model write writes, how many rows or in what order, or does not
 * run the write through `query` once (a call after a failed attempt is allowed). The audit records
 * the write from the arguments the extension received, so it rejects before the write runs where it
 * can. Values and row-picking fields (the top-level `where`, the unique `where` and filters of
 * nested writes) are not compared.
 */
export class AuditExtensionContinuationError extends Error {
  /** The `name` of the extension, when it has one */
  readonly extensionName: string | undefined;
  readonly modelName: string;
  readonly operation: string;
  readonly violation: AuditContinuationViolation;

  constructor({
    extensionName,
    modelName,
    operation,
    violation,
  }: {
    readonly extensionName: string | undefined;
    readonly modelName: string;
    readonly operation: string;
    readonly violation: AuditContinuationViolation;
  }) {
    const extension = extensionName === undefined ? 'a query extension' : `the query extension "${extensionName}"`;
    super(
      `An audited ${operation} on ${modelName} was rejected: ${extension} applied after the audit handles it, and ${describeViolation(violation)}, which the audit cannot record. An extension that changes which rows or relations an operation writes, or replaces the operation, belongs on the client passed to createAuditClient; one applied after the audit may change values only and must continue the operation through query once, again only after a failed attempt`,
    );
    this.name = 'AuditExtensionContinuationError';
    this.extensionName = extensionName;
    this.modelName = modelName;
    this.operation = operation;
    this.violation = violation;
  }
}
