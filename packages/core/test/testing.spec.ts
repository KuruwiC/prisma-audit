import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockAuditContext } from '../src/testing/index.js';
import type { AuditContext } from '../src/types.js';

describe('createMockAuditContext', () => {
  it('should allow setting and getting context', () => {
    const mock = createMockAuditContext();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'test-user' },
    };

    mock.setContext(context);
    expect(mock.getContext()).toEqual(context);
    expect(mock.provider.getContext()).toEqual(context);
  });

  it('should clear context', () => {
    const mock = createMockAuditContext();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'test-user' },
    };

    mock.setContext(context);
    expect(mock.getContext()).toEqual(context);

    mock.clear();
    expect(mock.getContext()).toBeUndefined();
    expect(mock.provider.getContext()).toBeUndefined();
  });

  it('should work with provider.run', () => {
    const mock = createMockAuditContext();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'test-user' },
    };

    const result = mock.provider.run(context, () => {
      const ctx = mock.provider.getContext();
      expect(ctx).toEqual(context);
      return 'sync-result';
    });

    expect(result).toBe('sync-result');
  });

  it('should work with provider.runAsync', async () => {
    const mock = createMockAuditContext();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'test-user' },
    };

    const result = await mock.provider.runAsync(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const ctx = mock.provider.getContext();
      expect(ctx).toEqual(context);
      return 'async-result';
    });

    expect(result).toBe('async-result');
  });

  it.each([
    [
      'run',
      (mock: ReturnType<typeof createMockAuditContext>, temporary: AuditContext, fn: () => void) =>
        mock.provider.run(temporary, fn),
    ],
    [
      'runAsync',
      async (mock: ReturnType<typeof createMockAuditContext>, temporary: AuditContext, fn: () => void) =>
        await mock.provider.runAsync(temporary, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          fn();
        }),
    ],
  ] as const)('should restore previous context after %s', async (_, runFn) => {
    const mock = createMockAuditContext();

    const initialContext: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'initial-user' },
    };

    const temporaryContext: AuditContext = {
      actor: { category: 'system', type: 'Admin', id: 'temp-admin' },
    };

    mock.setContext(initialContext);
    expect(mock.getContext()).toEqual(initialContext);

    await runFn(mock, temporaryContext, () => {
      expect(mock.provider.getContext()).toEqual(temporaryContext);
    });

    expect(mock.getContext()).toEqual(initialContext);
  });

  describe('Testing workflow', () => {
    let mock: ReturnType<typeof createMockAuditContext>;

    beforeEach(() => {
      mock = createMockAuditContext();
      mock.setContext({
        actor: { category: 'model', type: 'User', id: 'test-user', name: 'Test User' },
        request: { testMode: true },
      });
    });

    afterEach(() => {
      mock.clear();
    });

    it('should have context available in test', () => {
      const ctx = mock.provider.getContext();
      expect(ctx).toBeDefined();
      expect(ctx?.actor.type).toBe('User');
      expect(ctx?.actor.id).toBe('test-user');
    });

    it('should work with custom request metadata', () => {
      const ctx = mock.provider.getContext();
      expect(ctx?.request?.testMode).toBe(true);
    });
  });

  it.each([
    [
      'run',
      (mock: ReturnType<typeof createMockAuditContext>, ctx: AuditContext) => {
        expect(() => {
          mock.provider.run(ctx, () => {
            throw new Error('Test error');
          });
        }).toThrow('Test error');
      },
    ],
    [
      'runAsync',
      async (mock: ReturnType<typeof createMockAuditContext>, ctx: AuditContext) => {
        await expect(
          mock.provider.runAsync(ctx, async () => {
            throw new Error('Async test error');
          }),
        ).rejects.toThrow('Async test error');
      },
    ],
  ] as const)('should handle errors in %s', async (_, testFn) => {
    const mock = createMockAuditContext();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'test-user' },
    };

    await testFn(mock, context);
  });
});
