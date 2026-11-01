import { describe, expect, it, vi } from 'vitest';
import { getGlobalSingleton } from '../src/global-singleton.js';

describe('getGlobalSingleton', () => {
  it('should return the identical instance for the same key across calls with different factories', () => {
    const key = `test-same-key-${Math.random()}`;
    const first = getGlobalSingleton(key, () => ({ value: 'first' }));
    const second = getGlobalSingleton(key, () => ({ value: 'second' }));

    expect(second).toBe(first);
    expect(second).toEqual({ value: 'first' });
  });

  it('should return distinct instances for different keys', () => {
    const suffix = Math.random();
    const a = getGlobalSingleton(`test-key-a-${suffix}`, () => ({ id: 'a' }));
    const b = getGlobalSingleton(`test-key-b-${suffix}`, () => ({ id: 'b' }));

    expect(a).not.toBe(b);
    expect(a).toEqual({ id: 'a' });
    expect(b).toEqual({ id: 'b' });
  });

  it('should invoke the factory only once for a given key', () => {
    const key = `test-factory-once-${Math.random()}`;
    let calls = 0;
    const factory = () => {
      calls += 1;
      return {};
    };

    getGlobalSingleton(key, factory);
    getGlobalSingleton(key, factory);

    expect(calls).toBe(1);
  });

  it('should share the instance across two loaded copies of the module', async () => {
    const key = `test-two-copies-${Math.random()}`;
    const first = { value: 'first' };

    vi.resetModules();
    const firstCopy = await import('../src/global-singleton.js');
    vi.resetModules();
    const secondCopy = await import('../src/global-singleton.js');

    expect(firstCopy.getGlobalSingleton).not.toBe(secondCopy.getGlobalSingleton);
    expect(firstCopy.getGlobalSingleton(key, () => first)).toBe(first);
    expect(secondCopy.getGlobalSingleton(key, () => ({ value: 'second' }))).toBe(first);
  });
});
