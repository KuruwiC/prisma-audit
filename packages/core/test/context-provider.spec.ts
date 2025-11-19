import { describe, expect, it } from 'vitest';
import { createAsyncLocalStorageProvider } from '../src/context-provider.js';
import type { AuditContext } from '../src/types.js';

describe('createAsyncLocalStorageProvider', () => {
  it('should return undefined when no context is set', () => {
    const provider = createAsyncLocalStorageProvider();
    expect(provider.getContext()).toBeUndefined();
  });

  it('should propagate context in synchronous run', () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-123' },
    };

    const result = provider.run(context, () => {
      const ctx = provider.getContext();
      expect(ctx).toEqual(context);
      return 'success';
    });

    expect(result).toBe('success');
    expect(provider.getContext()).toBeUndefined();
  });

  it('should propagate context in async runAsync', async () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-123' },
    };

    const result = await provider.runAsync(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      const ctx = provider.getContext();
      expect(ctx).toEqual(context);
      return 'async-success';
    });

    expect(result).toBe('async-success');
    expect(provider.getContext()).toBeUndefined();
  });

  it('should propagate context across nested async calls', async () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'Admin', id: 'admin-456' },
      request: { tenantId: 'tenant-789' },
    };

    const nestedAsyncFunction = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return provider.getContext();
    };

    await provider.runAsync(context, async () => {
      const ctx1 = provider.getContext();
      expect(ctx1).toEqual(context);

      const ctx2 = await nestedAsyncFunction();
      expect(ctx2).toEqual(context);

      const ctx3 = provider.getContext();
      expect(ctx3).toEqual(context);
    });
  });

  it('should isolate contexts in parallel async operations', async () => {
    const provider = createAsyncLocalStorageProvider();

    const context1: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-1' },
    };

    const context2: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-2' },
    };

    const results = await Promise.all([
      provider.runAsync(context1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const ctx = provider.getContext();
        expect(ctx).toEqual(context1);
        return 'result-1';
      }),
      provider.runAsync(context2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ctx = provider.getContext();
        expect(ctx).toEqual(context2);
        return 'result-2';
      }),
    ]);

    expect(results).toEqual(['result-1', 'result-2']);
  });

  it('should handle errors in run and restore context', () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-123' },
    };

    expect(() => {
      provider.run(context, () => {
        throw new Error('Test error');
      });
    }).toThrow('Test error');

    expect(provider.getContext()).toBeUndefined();
  });

  it('should handle errors in runAsync and restore context', async () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-123' },
    };

    await expect(
      provider.runAsync(context, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('Async test error');
      }),
    ).rejects.toThrow('Async test error');

    expect(provider.getContext()).toBeUndefined();
  });

  it('should handle nested contexts correctly', () => {
    const provider = createAsyncLocalStorageProvider();

    const outerContext: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'outer-user' },
    };

    const innerContext: AuditContext = {
      actor: { category: 'system', type: 'Admin', id: 'inner-admin' },
    };

    provider.run(outerContext, () => {
      expect(provider.getContext()).toEqual(outerContext);

      provider.run(innerContext, () => {
        expect(provider.getContext()).toEqual(innerContext);
      });

      expect(provider.getContext()).toEqual(outerContext);
    });

    expect(provider.getContext()).toBeUndefined();
  });

  it('should preserve custom request metadata', () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-123', name: 'John Doe' },
      request: {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        tenantId: 'tenant-456',
      },
    };

    provider.run(context, () => {
      const ctx = provider.getContext();
      expect(ctx?.request).toEqual({
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        tenantId: 'tenant-456',
      });
    });
  });

  describe('useContext', () => {
    it('should return context when available', () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
      };

      provider.run(context, () => {
        const ctx = provider.useContext();
        expect(ctx).toEqual(context);
        expect(ctx.actor.id).toBe('user-123');
      });
    });

    it('should throw helpful error when context is not available', () => {
      const provider = createAsyncLocalStorageProvider();

      expect(() => {
        provider.useContext();
      }).toThrow('[@prisma-audit] AuditContext is not available');
      expect(() => {
        provider.useContext();
      }).toThrow('Make sure you are running within a context provider');
    });

    it('should work in async context', async () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'system', type: 'CronJob', id: 'job-123' },
      };

      await provider.runAsync(context, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ctx = provider.useContext();
        expect(ctx).toEqual(context);
        expect(ctx.actor.type).toBe('CronJob');
      });
    });

    it('should be isolated between parallel operations', async () => {
      const provider = createAsyncLocalStorageProvider();

      const context1: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      };

      const context2: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-2' },
      };

      const results = await Promise.all([
        provider.runAsync(context1, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const ctx = provider.useContext();
          expect(ctx.actor.id).toBe('user-1');
          return ctx.actor.id;
        }),
        provider.runAsync(context2, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const ctx = provider.useContext();
          expect(ctx.actor.id).toBe('user-2');
          return ctx.actor.id;
        }),
      ]);

      expect(results).toEqual(['user-1', 'user-2']);
    });
  });
});
