import { describe, expect, it, vi } from 'vitest';
import { createErrorHandler, withErrorHandling, withErrorHandlingSync } from '../../src/index.js';

describe('createErrorHandler', () => {
  describe('throw strategy', () => {
    it('should rethrow errors', () => {
      const handler = createErrorHandler('throw');
      const error = new Error('Test error');

      expect(() => handler(error, 'test context')).toThrow('Test error');
    });

    it('should preserve error type', () => {
      const handler = createErrorHandler('throw');
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }
      const error = new CustomError('Custom error');

      expect(() => handler(error, 'test context')).toThrow(CustomError);
    });
  });

  describe('log strategy', () => {
    it('should log errors to console', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('log');
      const error = new Error('Test error');

      handler(error, 'test context');

      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, '[@prisma-audit] Error in test context:', 'Test error');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy.mock.calls[1]?.[0]).toContain('Error: Test error');

      consoleErrorSpy.mockRestore();
    });

    it('should not throw after logging', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('log');
      const error = new Error('Test error');

      expect(() => handler(error, 'test context')).not.toThrow();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('ignore strategy', () => {
    it('should silently ignore errors', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('ignore');
      const error = new Error('Test error');

      expect(() => handler(error, 'test context')).not.toThrow();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('custom handler', () => {
    it('should use custom handler when provided', () => {
      const customHandler = vi.fn();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('log', customHandler);
      const error = new Error('Test error');

      handler(error, 'test context');

      expect(customHandler).toHaveBeenCalledWith(error, 'test context');
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should execute both custom handler and strategy', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const customHandler = vi.fn();
      const handler = createErrorHandler('log', customHandler);
      const error = new Error('Test error');

      handler(error, 'test context');

      expect(customHandler).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('default strategy', () => {
    it('should default to log strategy', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler();
      const error = new Error('Test error');

      handler(error, 'test context');

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});

describe('withErrorHandling', () => {
  it('should execute async function successfully', async () => {
    const handler = createErrorHandler('log');
    const fn = async () => 'success';

    const result = await withErrorHandling(fn, handler, 'test');

    expect(result).toBe('success');
  });

  it('should catch and handle errors with throw strategy', async () => {
    const handler = createErrorHandler('throw');
    const fn = async () => {
      throw new Error('Async error');
    };

    await expect(withErrorHandling(fn, handler, 'test')).rejects.toThrow('Async error');
  });

  it('should catch and handle errors with log strategy', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createErrorHandler('log');
    const fn = async () => {
      throw new Error('Async error');
    };

    const result = await withErrorHandling(fn, handler, 'test');

    expect(result).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should catch and handle errors with ignore strategy', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createErrorHandler('ignore');
    const fn = async () => {
      throw new Error('Async error');
    };

    const result = await withErrorHandling(fn, handler, 'test');

    expect(result).toBeUndefined();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should work with custom error handler', async () => {
    const customHandler = vi.fn();
    const handler = createErrorHandler('log', customHandler);
    const fn = async () => {
      throw new Error('Async error');
    };

    await withErrorHandling(fn, handler, 'test');

    expect(customHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'Async error' }), 'test');
  });

  it('should preserve return value type', async () => {
    const handler = createErrorHandler('log');
    const fn = async () => ({ data: 'test', count: 42 });

    const result = await withErrorHandling(fn, handler, 'test');

    expect(result).toEqual({ data: 'test', count: 42 });
  });
});

describe('withErrorHandlingSync', () => {
  it('should execute sync function successfully', () => {
    const handler = createErrorHandler('log');
    const fn = () => 'success';

    const result = withErrorHandlingSync(fn, handler, 'test');

    expect(result).toBe('success');
  });

  it('should catch and handle errors with throw strategy', () => {
    const handler = createErrorHandler('throw');
    const fn = () => {
      throw new Error('Sync error');
    };

    expect(() => withErrorHandlingSync(fn, handler, 'test')).toThrow('Sync error');
  });

  it('should catch and handle errors with log strategy', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createErrorHandler('log');
    const fn = () => {
      throw new Error('Sync error');
    };

    const result = withErrorHandlingSync(fn, handler, 'test');

    expect(result).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should catch and handle errors with ignore strategy', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createErrorHandler('ignore');
    const fn = () => {
      throw new Error('Sync error');
    };

    const result = withErrorHandlingSync(fn, handler, 'test');

    expect(result).toBeUndefined();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should work with custom error handler', () => {
    const customHandler = vi.fn();
    const handler = createErrorHandler('log', customHandler);
    const fn = () => {
      throw new Error('Sync error');
    };

    withErrorHandlingSync(fn, handler, 'test');

    expect(customHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'Sync error' }), 'test');
  });

  it('should preserve return value type', () => {
    const handler = createErrorHandler('log');
    const fn = () => ({ data: 'test', count: 42 });

    const result = withErrorHandlingSync(fn, handler, 'test');

    expect(result).toEqual({ data: 'test', count: 42 });
  });
});

describe('error handling integration', () => {
  it('should handle nested async operations', async () => {
    const handler = createErrorHandler('log');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const nestedFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('Nested error');
    };

    const fn = async () => {
      await withErrorHandling(nestedFn, handler, 'nested');
      return 'completed';
    };

    const result = await withErrorHandling(fn, handler, 'outer');

    expect(result).toBe('completed');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

    consoleErrorSpy.mockRestore();
  });

  it('should handle mixed sync and async operations', async () => {
    const handler = createErrorHandler('ignore');

    const syncFn = () => {
      throw new Error('Sync error');
    };

    const asyncFn = async () => {
      withErrorHandlingSync(syncFn, handler, 'sync');
      return 'success';
    };

    const result = await withErrorHandling(asyncFn, handler, 'async');

    expect(result).toBe('success');
  });
});
