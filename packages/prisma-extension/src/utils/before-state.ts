import type { BeforeState } from '@kuruwic/db-audit-core';

export const NO_BEFORE_STATE: BeforeState = { kind: 'none' };

export const UNAVAILABLE_BEFORE_STATE: BeforeState = { kind: 'unavailable' };

export const beforeStateOf = (row: Record<string, unknown> | null | undefined): BeforeState =>
  row ? { kind: 'captured', row } : NO_BEFORE_STATE;
