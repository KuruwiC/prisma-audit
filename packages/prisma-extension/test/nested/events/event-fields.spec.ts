import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, type AuditAction } from '../../../src/grammar/operations.js';
import { identityOf, toMutationAction } from '../../../src/nested/events/event-fields.js';

const origin = { model: 'Post', path: 'posts' };

describe('identityOf', () => {
  it('gives the value of a single-field primary key', () => {
    expect(identityOf({ id: 'p1', title: 'T' }, ['id'], origin)).toBe('p1');
  });

  it('gives the JSON array of the values of a composite primary key', () => {
    expect(identityOf({ postId: 'p1', tagId: 't1' }, ['postId', 'tagId'], origin)).toBe('["p1","t1"]');
  });

  it('is empty for a row that lacks a primary-key field', () => {
    expect(identityOf({ title: 'T' }, ['id'], origin)).toBe('');
    expect(identityOf({ postId: 'p1' }, ['postId', 'tagId'], origin)).toBe('');
  });

  it('is empty for a row whose primary-key field is null', () => {
    expect(identityOf({ id: null }, ['id'], origin)).toBe('');
  });

  it('is empty for a model without a primary key', () => {
    expect(identityOf({ id: 'p1' }, undefined, origin)).toBe('');
  });
});

describe('toMutationAction', () => {
  it.each([
    [AUDIT_ACTION.CREATE, 'create'],
    [AUDIT_ACTION.CREATE_MANY, 'create'],
    [AUDIT_ACTION.CREATE_MANY_AND_RETURN, 'create'],
    [AUDIT_ACTION.UPDATE, 'update'],
    [AUDIT_ACTION.UPDATE_MANY, 'update'],
    [AUDIT_ACTION.UPDATE_MANY_AND_RETURN, 'update'],
    [AUDIT_ACTION.DELETE, 'delete'],
    [AUDIT_ACTION.DELETE_MANY, 'delete'],
  ] as const)('maps %s to %s whatever the before state', (action, expected) => {
    expect(toMutationAction(action, { kind: 'captured', row: { id: 'p1' } })).toBe(expected);
    expect(toMutationAction(action, { kind: 'none' })).toBe(expected);
  });

  it('resolves an upsert to update when its row was captured, else to create', () => {
    expect(toMutationAction(AUDIT_ACTION.UPSERT, { kind: 'captured', row: { id: 'p1' } })).toBe('update');
    expect(toMutationAction(AUDIT_ACTION.UPSERT, { kind: 'none' })).toBe('create');
    expect(toMutationAction(AUDIT_ACTION.UPSERT, { kind: 'unavailable' })).toBe('create');
  });

  it('rejects an action it does not know', () => {
    expect(() => toMutationAction('truncate' as AuditAction, { kind: 'none' })).toThrow(
      '[@prisma-audit] Unknown action: truncate',
    );
  });
});
