import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorHandler } from '../../src/utils/error-handler.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

    it('should run the custom handler before rethrowing', () => {
      const customHandler = vi.fn();
      const handler = createErrorHandler('throw', customHandler);
      const error = new Error('Test error');

      expect(() => handler(error, 'test context')).toThrow(error);
      expect(customHandler).toHaveBeenCalledExactlyOnceWith(error, 'test context');
    });
  });

  describe('log strategy', () => {
    it('should log errors to console', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('log');
      const error = new Error('Test error');

      handler(error, 'test context');

      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, '[db-audit-core] Error in test context:', 'Test error');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy.mock.calls[1]?.[0]).toContain('Error: Test error');
    });
  });

  describe('ignore strategy', () => {
    it('should silently ignore errors', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('ignore');
      const error = new Error('Test error');

      expect(() => handler(error, 'test context')).not.toThrow();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
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
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, '[db-audit-core] Error in test context:', 'Test error');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    });

    it("should log a custom handler's synchronous throw instead of propagating it", () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler('ignore', () => {
        throw new Error('handler failed');
      });

      expect(() => handler(new Error('Test error'), 'test context')).not.toThrow();
      expect(consoleErrorSpy.mock.calls).toEqual([
        ['[db-audit-core] Error in custom error handler:', 'handler failed'],
      ]);
    });

    it("should log a custom handler's rejection instead of propagating it", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const rejection = Promise.reject(new Error('handler rejected'));
      const handler = createErrorHandler('ignore', () => rejection);

      expect(() => handler(new Error('Test error'), 'test context')).not.toThrow();
      await rejection.catch(() => {});

      expect(consoleErrorSpy.mock.calls).toEqual([
        ['[db-audit-core] Error in async custom error handler:', 'handler rejected'],
      ]);
    });
  });

  describe('default strategy', () => {
    it('should default to log strategy', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = createErrorHandler();
      const error = new Error('Test error');

      handler(error, 'test context');

      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, '[db-audit-core] Error in test context:', 'Test error');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    });
  });
});
