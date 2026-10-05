/**
 * Unit tests for the columns an audit record stores of a row: those its before state holds, and
 * without a before state, the row less the columns a widened select added
 */

import type { MutationEvent } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { keepAuditedColumns } from '../../src/pipeline/audited-columns.js';

const update = (before: MutationEvent['before'], after: Record<string, unknown>): MutationEvent => ({
  model: 'User',
  identity: 'u1',
  action: 'update',
  before,
  after,
  origin: { path: '', op: 'update' },
});

const NOTHING_WIDENED = new Map<string, ReadonlySet<string>>();

describe('keepAuditedColumns', () => {
  it('leaves out of the after state a column its captured before state does not hold', () => {
    const event = update(
      { kind: 'captured', row: { id: 'u1', name: 'Ada' } },
      { id: 'u1', name: 'Bea', password: 'hash' },
    );

    expect(keepAuditedColumns(event, NOTHING_WIDENED).after).toEqual({ id: 'u1', name: 'Bea' });
  });

  it('returns the event itself when the before state holds every column of the after state', () => {
    const event = update({ kind: 'captured', row: { id: 'u1', name: 'Ada' } }, { id: 'u1', name: 'Bea' });

    expect(keepAuditedColumns(event, NOTHING_WIDENED)).toBe(event);
  });

  it('leaves out the widened columns of a row without a captured before state', () => {
    const widened = new Map([['User', new Set(['email', 'password'])]]);
    const created: MutationEvent = {
      ...update({ kind: 'none' }, { id: 'u1', email: 'e', password: 'hash' }),
      action: 'create',
    };

    expect(keepAuditedColumns(created, widened).after).toEqual({ id: 'u1' });
    expect(keepAuditedColumns(update({ kind: 'unavailable' }, { id: 'u1', password: 'hash' }), widened).after).toEqual({
      id: 'u1',
    });
  });

  it('keeps every column of a row without a before state when nothing was widened for its model', () => {
    const widened = new Map([['Post', new Set(['title'])]]);
    const event = update({ kind: 'none' }, { id: 'u1', password: 'hash' });

    expect(keepAuditedColumns(event, widened)).toBe(event);
  });
});
