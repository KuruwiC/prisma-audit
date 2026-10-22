import { describe, expect, it } from 'vitest';
import { toError } from '../../src/utils/to-error.js';

describe('toError', () => {
  it('should return an Error unchanged', () => {
    const error = new TypeError('boom');
    expect(toError(error)).toBe(error);
  });

  it('should wrap a value that converts to a string, using that string as the message', () => {
    expect(toError('boom').message).toBe('boom');
    expect(toError(42).message).toBe('42');
    expect(toError(undefined).message).toBe('undefined');
    expect(toError({ toString: () => 'custom' }).message).toBe('custom');
  });

  it('should keep a wrapped value that converts to a string as the cause', () => {
    const caught = { id: 1 };
    expect(toError(caught).cause).toBe(caught);
    expect(toError('boom').cause).toBe('boom');
  });

  it('should wrap an object without a prototype, keeping it as the cause', () => {
    const caught = Object.create(null);
    const error = toError(caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(caught);
  });

  it('should wrap a value whose toString throws, keeping it as the cause', () => {
    const caught = {
      toString: () => {
        throw new Error('toString failed');
      },
    };
    const error = toError(caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(caught);
  });

  it('should use the string form of a value on which only the instanceof check throws', () => {
    const caught = new Proxy(
      { toString: () => 'converted' },
      {
        getPrototypeOf: () => {
          throw new Error('trap failed');
        },
      },
    );
    const error = toError(caught);
    expect(error.message).toBe('converted');
    expect(error.cause).toBe(caught);
  });

  it('should wrap a revoked proxy, on which the instanceof check throws, keeping it as the cause', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const error = toError(proxy);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(proxy);
  });
});
