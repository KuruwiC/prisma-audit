import { describe, expect, it, vi } from 'vitest';
import { AuditAtomicityError, planFor, policy, type WriteMode } from '../src/policy/index.js';

describe('policy', () => {
  it.each(['atomic', 'awaited', 'deferred'] as const)('is %s for every model when the mode is that value', (mode) => {
    expect(policy(['User', 'Post'], { mode })).toBe(mode);
  });

  it('calls the mode function once per audited model, with its name', () => {
    const mode = vi.fn((): WriteMode => 'awaited');

    policy(['User', 'Payment'], { mode });

    expect(mode).toHaveBeenCalledTimes(2);
    expect(mode).toHaveBeenNthCalledWith(1, 'User');
    expect(mode).toHaveBeenNthCalledWith(2, 'Payment');
  });

  it.each([
    { modes: { User: 'deferred', Payment: 'atomic' }, strongest: 'atomic' },
    { modes: { User: 'awaited', Payment: 'deferred' }, strongest: 'awaited' },
    { modes: { User: 'atomic', Payment: 'awaited' }, strongest: 'atomic' },
    { modes: { User: 'deferred', Payment: 'deferred' }, strongest: 'deferred' },
  ] as const)('takes the strongest mode of the audited models ($strongest)', ({ modes, strongest }) => {
    expect(policy(['User', 'Payment'], { mode: (modelName) => modes[modelName as keyof typeof modes] })).toBe(
      strongest,
    );
  });

  it('is deferred, the weakest mode, for no audited model, without calling the mode function', () => {
    const mode = vi.fn((): WriteMode => 'atomic');

    expect(policy([], { mode })).toBe('deferred');
    expect(mode).not.toHaveBeenCalled();
  });
});

describe('planFor', () => {
  it.each([
    { mode: 'atomic', inOwnedTransaction: true, plan: 'immediate' },
    { mode: 'atomic', inOwnedTransaction: false, plan: 'reject' },
    { mode: 'awaited', inOwnedTransaction: true, plan: 'immediate' },
    { mode: 'awaited', inOwnedTransaction: false, plan: 'awaited-after-commit' },
    { mode: 'deferred', inOwnedTransaction: true, plan: 'after-commit' },
    { mode: 'deferred', inOwnedTransaction: false, plan: 'detached' },
  ] as const)(
    'plans $plan for $mode, inOwnedTransaction: $inOwnedTransaction',
    ({ mode, inOwnedTransaction, plan }) => {
      expect(planFor(mode, inOwnedTransaction)).toBe(plan);
    },
  );
});

describe('AuditAtomicityError', () => {
  it('names the operation it rejects', () => {
    const error = new AuditAtomicityError({ modelName: 'Payment', operation: 'create' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuditAtomicityError');
    expect(error.modelName).toBe('Payment');
    expect(error.operation).toBe('create');
    expect(error.message).toContain('create on Payment');
  });
});
