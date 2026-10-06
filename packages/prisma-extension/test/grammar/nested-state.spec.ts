import { describe, expect, it } from 'vitest';
import {
  resolveConnectOrCreateState,
  resolveCreateState,
  resolveUpdateState,
  resolveUpsertState,
  upsertBranchOf,
} from '../../src/grammar/nested-state.js';
import { NO_BEFORE_STATE, UNAVAILABLE_BEFORE_STATE } from '../../src/utils/before-state.js';

const captured = { kind: 'captured', row: { id: 'p1', title: 'Before' } } as const;

describe('upsertBranchOf', () => {
  it('is update when the row was captured', () => {
    expect(upsertBranchOf(captured)).toBe('update');
  });

  it('is create when the read found no row', () => {
    expect(upsertBranchOf(NO_BEFORE_STATE)).toBe('create');
  });

  it('is undefined when the read failed', () => {
    expect(upsertBranchOf(UNAVAILABLE_BEFORE_STATE)).toBeUndefined();
  });
});

describe('resolveUpsertState', () => {
  it('audits an update with the captured row as its before state', () => {
    expect(resolveUpsertState(captured)).toEqual({ action: 'update', before: captured });
  });

  it('audits a create with no before state', () => {
    expect(resolveUpsertState(NO_BEFORE_STATE)).toEqual({ action: 'create', before: NO_BEFORE_STATE });
  });

  it('audits nothing when the target could not be read', () => {
    expect(resolveUpsertState(UNAVAILABLE_BEFORE_STATE)).toBeNull();
  });
});

describe('resolveConnectOrCreateState', () => {
  it('audits a create with no before state when the row did not exist', () => {
    expect(resolveConnectOrCreateState(NO_BEFORE_STATE)).toEqual({ action: 'create', before: NO_BEFORE_STATE });
  });

  it('audits nothing when the row existed and was connected', () => {
    expect(resolveConnectOrCreateState(captured)).toBeNull();
  });

  it('audits nothing when the target could not be read', () => {
    expect(resolveConnectOrCreateState(UNAVAILABLE_BEFORE_STATE)).toBeNull();
  });
});

describe('resolveUpdateState', () => {
  it.each([
    ['a captured row', captured],
    ['no row', NO_BEFORE_STATE],
    ['an unavailable read', UNAVAILABLE_BEFORE_STATE],
  ])('audits an update that keeps %s as its before state', (_name, before) => {
    expect(resolveUpdateState(before)).toEqual({ action: 'update', before });
  });
});

describe('resolveCreateState', () => {
  it('audits a create with no before state', () => {
    expect(resolveCreateState()).toEqual({ action: 'create', before: NO_BEFORE_STATE });
  });
});
