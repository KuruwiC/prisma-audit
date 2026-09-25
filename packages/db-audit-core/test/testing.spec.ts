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

  describe('withActor', () => {
    it('should override only the actor and preserve request metadata', async () => {
      const mock = createMockAuditContext();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { traceId: 'trace-1' },
      };

      mock.setContext(context);

      // withActor is async; await it so the outer assertion runs after the context is restored.
      await mock.provider.withActor({ category: 'system', type: 'Admin', id: 'admin-456' }, () => {
        const ctx = mock.provider.getContext();
        expect(ctx?.actor).toEqual({ category: 'system', type: 'Admin', id: 'admin-456' });
        expect(ctx?.request).toEqual(context.request);
      });

      expect(mock.getContext()).toEqual(context);
    });

    it('should work with no current context', async () => {
      const mock = createMockAuditContext();

      await mock.provider.withActor({ category: 'system', type: 'Admin', id: 'admin-456' }, () => {
        const ctx = mock.provider.getContext();
        expect(ctx?.actor).toEqual({ category: 'system', type: 'Admin', id: 'admin-456' });
        expect(ctx?.request).toBeUndefined();
      });

      expect(mock.getContext()).toBeUndefined();
    });

    it('should pass through the return value', async () => {
      const mock = createMockAuditContext();

      // withActor always returns a Promise; await it to get the resolved value.
      const result = await mock.provider.withActor(
        { category: 'system', type: 'Admin', id: 'admin-456' },
        () => 'value',
      );

      expect(result).toBe('value');
    });

    // The mock's withActor must await fn's return value inside the overridden
    // scope, matching the real ALS provider's async wrapper semantics. A plain
    // arrow returning a lazy thenable must resolve under actor2, not the outer
    // actor that was set before withActor was called.
    it('plain arrow returning a lazy thenable resolves under the overridden actor', async () => {
      const mock = createMockAuditContext();
      const seen: string[] = [];

      mock.setContext({ actor: { category: 'model', type: 'User', id: 'outer-user' } });

      const actor2 = { category: 'system' as const, type: 'Admin', id: 'actor-2' };

      // Mimics PrismaPromise: records the active actor when .then is invoked.
      const lazyOp = () => ({
        then(onFulfilled: (v: unknown) => unknown) {
          seen.push(mock.provider.getContext()?.actor.id ?? 'none');
          return Promise.resolve().then(() => onFulfilled(undefined));
        },
      });

      await mock.provider.withActor(actor2, () => lazyOp() as unknown as Promise<unknown>);

      expect(seen).toEqual(['actor-2']);
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
