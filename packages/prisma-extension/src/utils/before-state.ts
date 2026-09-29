import type { BeforeState } from '@kuruwic/db-audit-core';

export const NO_BEFORE_STATE: BeforeState = { kind: 'none' };

export const beforeStateOf = (row: Record<string, unknown> | null | undefined): BeforeState =>
  row ? { kind: 'captured', row } : NO_BEFORE_STATE;
