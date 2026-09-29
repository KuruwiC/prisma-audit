import type { BeforeState } from '@kuruwic/db-audit-core';

export const NO_BEFORE_STATE: BeforeState = { kind: 'none' };

/** The before state a read of a row yields: the row it found as captured, none when it found no row */
export const beforeStateOf = (row: Record<string, unknown> | null | undefined): BeforeState =>
  row ? { kind: 'captured', row } : NO_BEFORE_STATE;
