import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch/index.js';
import { createActorId, createAggregateId, createEntityId } from '../src/domain/branded-types.js';
import type { AuditRecord } from '../src/domain/mutation-event.js';

const records: AuditRecord[] = [
  {
    actorCategory: 'model',
    actorType: 'User',
    actorId: createActorId('user-1'),
    actorContext: null,
    entityCategory: 'model',
    entityType: 'Post',
    entityId: createEntityId('post-1'),
    entityContext: null,
    aggregateCategory: 'model',
    aggregateType: 'Post',
    aggregateId: createAggregateId('post-1'),
    aggregateContext: null,
    action: 'create',
    before: null,
    after: { id: 'post-1' },
    changes: null,
    beforeUnavailable: false,
    requestContext: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
  },
];

describe('dispatch', () => {
  it.each([true, false])('plans an immediate write for an atomic policy (inTransaction: %s)', (inTransaction) => {
    expect(dispatch(records, true, { inTransaction })).toEqual({ kind: 'immediate', records });
  });

  it('plans an after-commit write for a non-atomic policy inside a transaction', () => {
    expect(dispatch(records, false, { inTransaction: true })).toEqual({ kind: 'after-commit', records });
  });

  it('plans a detached write for a non-atomic policy outside a transaction', () => {
    expect(dispatch(records, false, { inTransaction: false })).toEqual({ kind: 'detached', records });
  });

  it('carries the records through by reference', () => {
    expect(dispatch(records, true, { inTransaction: false }).records).toBe(records);
  });

  it('plans an empty record set the same way', () => {
    expect(dispatch([], false, { inTransaction: true })).toEqual({ kind: 'after-commit', records: [] });
  });
});
