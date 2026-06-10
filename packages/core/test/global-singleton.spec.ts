import { describe, expect, it } from 'vitest';
import { getGlobalSingleton } from '../src/global-singleton.js';

describe('getGlobalSingleton', () => {
  it('should return the identical instance for the same key across calls with different factories', () => {
    const key = `test-same-key-${Math.random()}`;
    const first = getGlobalSingleton(key, () => ({ value: 'first' }));
    // Second call with a different factory must NOT re-create — the first wins.
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
});
