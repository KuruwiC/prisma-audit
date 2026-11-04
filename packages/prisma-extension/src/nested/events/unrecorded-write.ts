/**
 * Writes the event collection leaves rows of without a record
 *
 * A row an operation wrote gets no record when the read that decides its action or finds it
 * failed: an upsert or connectOrCreate whose row could not be read cannot tell whether it created
 * the row, and the rows a detaching link write unlinks without naming them cannot be told when the
 * read of the rows its parent row held, or of that parent row, failed. The collection reports each
 * such write where it leaves the rows out; the read that failed is reported under `pre-fetch`.
 */

export interface UnrecordedWrite {
  readonly modelName: string;
  /** The write's keyword: the top-level action, or the nested operation */
  readonly operation: string;
  /** The write's nested path; empty for the top-level row */
  readonly path: string;
}

export type UnrecordedWriteReporter = (write: UnrecordedWrite) => void;
