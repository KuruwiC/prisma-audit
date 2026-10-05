import { describe, expect, it, vi } from 'vitest';
import { createErrorHandler } from '../../src/utils/error-handler.js';

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

      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, '[db-audit-core] Error in test context:', 'Test error');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy.mock.calls[1]?.[0]).toContain('Error: Test error');

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
