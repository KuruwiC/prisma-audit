/**
 * Writes the event collection leaves rows of without a record
 *
 * A row an operation wrote gets no record when the read that decides its action or finds it
 * failed: an upsert or connectOrCreate whose row could not be read cannot tell whether it created
 * the row, and the rows a detaching link write unlinks without naming them cannot be told when the
 * read of the rows its parent row held, or of that parent row, failed. The collection reports each
 * such write where it leaves the rows out; the read that failed is reported under `pre-fetch`.
 *
 * Only a write that leaves rows of an audited model is reported: the rows of another model get no
 * record either way. An upsert or connectOrCreate whose branch is unknown leaves its own row and
 * the rows the nested writes of either branch write, which are not detected below it; a detaching
 * link write leaves only the rows of its related model it unlinks.
 */

import type { UnrecordedWrite } from '@kuruwic/db-audit-core';

export type UnrecordedWriteReporter = (write: UnrecordedWrite) => void;

/**
 * The audited models whose rows a write on `modelName` with `args` writes, the nested writes of
 * every upsert branch included; `modelName` alone when `args` holds no nested write
 */
export type AuditedModelsOf = (modelName: string, args: unknown) => readonly string[];
