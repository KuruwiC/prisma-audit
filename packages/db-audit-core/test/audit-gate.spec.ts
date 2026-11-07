import { describe, expect, it, vi } from 'vitest';
import { AuditContextMissingError, AuditReentrantWriteError, auditGate } from '../src/policy/audit-gate.js';
import type { AuditContext } from '../src/types.js';

const context: AuditContext = { actor: { category: 'model', type: 'User', id: 'gate-actor' } };

describe('auditGate', () => {
  it.each([
    { scope: 'with', given: context },
    { scope: 'without', given: undefined },
  ])('skips a write that writes rows of no audited model, $scope an audit context', ({ given }) => {
    const requireContext = vi.fn(() => true);

    expect(auditGate({ context: given, auditedModels: [], withinAudit: false }, { requireContext })).toEqual({
      kind: 'skip',
    });
    expect(auditGate({ context: given, auditedModels: [], withinAudit: false }, { requireContext: true })).toEqual({
      kind: 'skip',
    });
    expect(requireContext).not.toHaveBeenCalled();
  });

  it.each([true, false])('audits a write of audited models under the audit context set, requireContext %s', (value) => {
    const requireContext = vi.fn(() => value);

    expect(
      auditGate({ context: context, auditedModels: ['User', 'Post'], withinAudit: false }, { requireContext: value }),
    ).toEqual({ kind: 'audit', context });
    expect(
      auditGate({ context: context, auditedModels: ['User', 'Post'], withinAudit: false }, { requireContext }),
    ).toEqual({ kind: 'audit', context });
    expect(requireContext).not.toHaveBeenCalled();
  });

  it.each([
    ['true', { requireContext: true }],
    ['unset', {}],
  ])('rejects a write without an audit context, requireContext %s, naming the first model', (_setting, config) => {
    expect(auditGate({ context: undefined, auditedModels: ['User', 'Post'], withinAudit: false }, config)).toEqual({
      kind: 'reject',
      modelName: 'User',
    });
  });

  it('runs a write without an audit context unaudited when requireContext is false', () => {
    expect(
      auditGate({ context: undefined, auditedModels: ['User', 'Post'], withinAudit: false }, { requireContext: false }),
    ).toEqual({
      kind: 'unaudited',
      reason: 'no-context',
    });
  });

  it('rejects a write without an audit context naming the first model the requireContext function is true for', () => {
    const requireContext = vi.fn((modelName: string) => modelName === 'Post' || modelName === 'Tag');

    expect(
      auditGate({ context: undefined, auditedModels: ['User', 'Post', 'Tag'], withinAudit: false }, { requireContext }),
    ).toEqual({
      kind: 'reject',
      modelName: 'Post',
    });
    expect(requireContext.mock.calls).toEqual([['User'], ['Post']]);
  });

  it('runs a write without an audit context unaudited when the requireContext function is false for every model', () => {
    const requireContext = vi.fn(() => false);

    expect(
      auditGate({ context: undefined, auditedModels: ['User', 'Post'], withinAudit: false }, { requireContext }),
    ).toEqual({
      kind: 'unaudited',
      reason: 'no-context',
    });
    expect(requireContext.mock.calls).toEqual([['User'], ['Post']]);
  });

  it.each([
    { scope: 'with', given: context },
    { scope: 'without', given: undefined },
  ])(
    'stops a write of audited models issued while the audit processes an operation as reentrant, naming the first model, $scope an audit context',
    ({ given }) => {
      const requireContext = vi.fn(() => true);

      expect(
        auditGate({ context: given, auditedModels: ['User', 'Post'], withinAudit: true }, { requireContext }),
      ).toEqual({ kind: 'reentrant', modelName: 'User' });
      expect(requireContext).not.toHaveBeenCalled();
    },
  );

  it('skips a write of no audited model issued while the audit processes an operation', () => {
    expect(auditGate({ context, auditedModels: [], withinAudit: true }, { requireContext: true })).toEqual({
      kind: 'skip',
    });
  });
});

describe('AuditReentrantWriteError', () => {
  it('names the model whose write was rejected, and the operation and its model', () => {
    const error = new AuditReentrantWriteError({ modelName: 'Post', operationModelName: 'User', operation: 'create' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuditReentrantWriteError');
    expect(error.modelName).toBe('Post');
    expect(error.operationModelName).toBe('User');
    expect(error.operation).toBe('create');
    expect(error.message).toBe(
      'A write to Post was rejected: a callback the audit runs (such as a resolver, an enricher, the writer or the observer) issued it while the audit processed an operation, where it would go unaudited. Write it from the caller instead, or through a client the audit is not applied to, to write it unaudited on purpose (operation create on User)',
    );
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
      "A write to Post was rejected: no audit context is set, and requireContext requires one for Post (operation create on User). Set an audit context for the write with the context provider's runAsync, with a system actor for a seed, migration or batch job. To run it unaudited on purpose, set requireContext to false, or to a function that returns false for Post.",
    );
  });
});
