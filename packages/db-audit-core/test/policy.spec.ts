import { describe, expect, it } from 'vitest';
import { createEntityConfigLookup } from '../src/aggregate/entity-config-lookup.js';
import { defineEntity } from '../src/aggregate/helpers.js';
import { AuditAtomicityError, planFor, policy, type WriteMode } from '../src/policy/index.js';

/** The entity lookup of an entity map declaring each model with its `writeMode`, or without one */
const entitiesWith = (writeModes: Readonly<Record<string, WriteMode | undefined>>) =>
  createEntityConfigLookup(
    Object.fromEntries(
      Object.entries(writeModes).map(([modelName, writeMode]) => [
        modelName,
        defineEntity({ type: modelName, writeMode }),
      ]),
    ),
  ).byModel;

describe('policy', () => {
  it('is atomic for a model whose entity sets no write mode, without a default mode', () => {
    expect(policy(['User'], { entity: entitiesWith({ User: undefined }) })).toBe('atomic');
  });

  it.each(['atomic', 'awaited', 'deferred'] as const)(
    'is the default mode, %s, for every model whose entity sets none',
    (mode) => {
      expect(policy(['User', 'Post'], { mode, entity: entitiesWith({ User: undefined, Post: undefined }) })).toBe(mode);
    },
  );

  it("takes an entity's write mode in place of the default", () => {
    expect(policy(['Post'], { mode: 'atomic', entity: entitiesWith({ Post: 'deferred' }) })).toBe('deferred');
  });

  it('finds the entity of a model whatever the case of its first letter', () => {
    expect(policy(['auditEvent'], { mode: 'atomic', entity: entitiesWith({ AuditEvent: 'awaited' }) })).toBe('awaited');
  });

  it.each([
    { modes: { User: 'deferred', Payment: 'atomic' }, strongest: 'atomic' },
    { modes: { User: 'awaited', Payment: 'deferred' }, strongest: 'awaited' },
    { modes: { User: 'atomic', Payment: 'awaited' }, strongest: 'atomic' },
    { modes: { User: 'deferred', Payment: 'deferred' }, strongest: 'deferred' },
  ] as const)('takes the strongest mode of the audited models ($strongest)', ({ modes, strongest }) => {
    expect(policy(['User', 'Payment'], { entity: entitiesWith(modes) })).toBe(strongest);
  });

  it('is deferred, the weakest mode, for no audited model', () => {
    expect(policy([], { mode: 'atomic', entity: entitiesWith({}) })).toBe('deferred');
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
