import { describe, expect, it, vi } from 'vitest';
import { AuditContextMissingError, auditGate } from '../src/policy/audit-gate.js';

describe('auditGate', () => {
  it.each([true, false])(
    'skips a write that writes rows of no audited model, with an audit context: %s',
    (hasContext) => {
      const requireContext = vi.fn(() => true);

      expect(auditGate(hasContext, [], { requireContext })).toEqual({ kind: 'skip' });
      expect(auditGate(hasContext, [], { requireContext: true })).toEqual({ kind: 'skip' });
      expect(requireContext).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'audits a write of audited models when an audit context is set, requireContext %s',
    (value) => {
      const requireContext = vi.fn(() => value);

      expect(auditGate(true, ['User', 'Post'], { requireContext: value })).toEqual({ kind: 'audit' });
      expect(auditGate(true, ['User', 'Post'], { requireContext })).toEqual({ kind: 'audit' });
      expect(requireContext).not.toHaveBeenCalled();
    },
  );

  it('rejects a write without an audit context when requireContext is true, naming the first model', () => {
    expect(auditGate(false, ['User', 'Post'], { requireContext: true })).toEqual({
      kind: 'reject',
      modelName: 'User',
    });
  });

  it('skips a write without an audit context when requireContext is false', () => {
    expect(auditGate(false, ['User', 'Post'], { requireContext: false })).toEqual({ kind: 'skip' });
  });

  it('rejects a write without an audit context naming the first model the requireContext function is true for', () => {
    const requireContext = vi.fn((modelName: string) => modelName === 'Post' || modelName === 'Tag');

    expect(auditGate(false, ['User', 'Post', 'Tag'], { requireContext })).toEqual({
      kind: 'reject',
      modelName: 'Post',
    });
    expect(requireContext.mock.calls).toEqual([['User'], ['Post']]);
  });

  it('skips a write without an audit context when the requireContext function is false for every model', () => {
    const requireContext = vi.fn(() => false);

    expect(auditGate(false, ['User', 'Post'], { requireContext })).toEqual({ kind: 'skip' });
    expect(requireContext.mock.calls).toEqual([['User'], ['Post']]);
  });

  it('rejects a write without an audit context when only a model it writes below the top level requires one', () => {
    expect(auditGate(false, ['User', 'Post'], { requireContext: (modelName) => modelName === 'Post' })).toEqual({
      kind: 'reject',
      modelName: 'Post',
    });
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
