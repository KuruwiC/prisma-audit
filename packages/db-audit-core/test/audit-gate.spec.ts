import { describe, expect, it, vi } from 'vitest';
import { AuditContextMissingError, auditGate } from '../src/policy/audit-gate.js';
import type { AuditContext } from '../src/types.js';

const context: AuditContext = { actor: { category: 'model', type: 'User', id: 'gate-actor' } };

describe('auditGate', () => {
  it.each([
    { scope: 'with', given: context },
    { scope: 'without', given: undefined },
  ])('skips a write that writes rows of no audited model, $scope an audit context', ({ given }) => {
    const requireContext = vi.fn(() => true);

    expect(auditGate(given, [], { requireContext })).toEqual({ kind: 'skip' });
    expect(auditGate(given, [], { requireContext: true })).toEqual({ kind: 'skip' });
    expect(requireContext).not.toHaveBeenCalled();
  });

  it.each([true, false])('audits a write of audited models under the audit context set, requireContext %s', (value) => {
    const requireContext = vi.fn(() => value);

    expect(auditGate(context, ['User', 'Post'], { requireContext: value })).toEqual({ kind: 'audit', context });
    expect(auditGate(context, ['User', 'Post'], { requireContext })).toEqual({ kind: 'audit', context });
    expect(requireContext).not.toHaveBeenCalled();
  });

  it('rejects a write without an audit context when requireContext is true, naming the first model', () => {
    expect(auditGate(undefined, ['User', 'Post'], { requireContext: true })).toEqual({
      kind: 'reject',
      modelName: 'User',
    });
  });

  it('skips a write without an audit context when requireContext is false', () => {
    expect(auditGate(undefined, ['User', 'Post'], { requireContext: false })).toEqual({ kind: 'skip' });
  });

  it('rejects a write without an audit context naming the first model the requireContext function is true for', () => {
    const requireContext = vi.fn((modelName: string) => modelName === 'Post' || modelName === 'Tag');

    expect(auditGate(undefined, ['User', 'Post', 'Tag'], { requireContext })).toEqual({
      kind: 'reject',
      modelName: 'Post',
    });
    expect(requireContext.mock.calls).toEqual([['User'], ['Post']]);
  });

  it('skips a write without an audit context when the requireContext function is false for every model', () => {
    const requireContext = vi.fn(() => false);

    expect(auditGate(undefined, ['User', 'Post'], { requireContext })).toEqual({ kind: 'skip' });
    expect(requireContext.mock.calls).toEqual([['User'], ['Post']]);
  });
});

describe('AuditContextMissingError', () => {
  it('names the model whose write was rejected, and the operation and its model', () => {
    const error = new AuditContextMissingError({ modelName: 'Post', operationModelName: 'User', operation: 'create' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuditContextMissingError');
    expect(error.modelName).toBe('Post');
    expect(error.operationModelName).toBe('User');
    expect(error.operation).toBe('create');
    expect(error.message).toBe(
      'A write to Post was rejected: no audit context is set, and requireContext requires one for Post (operation create on User)',
    );
  });
});
