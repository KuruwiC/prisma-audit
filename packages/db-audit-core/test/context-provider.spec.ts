import { describe, expect, it } from 'vitest';
import { createAsyncLocalStorageProvider } from '../src/context-provider.js';
import type { AuditActor, AuditContext } from '../src/types.js';

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
      }).toThrow('[db-audit-core] AuditContext is not available');
      expect(() => {
        provider.useContext();
      }).toThrow('Make sure you are running within a context provider');
    });
  });

  describe('withActor', () => {
    const otherActor: AuditActor = { category: 'system', type: 'Admin', id: 'admin-456' };

    it('should override only the actor and preserve request metadata', () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { ipAddress: '192.168.1.1', traceId: 'trace-1' },
      };

      provider.run(context, () => {
        provider.withActor(otherActor, () => {
          const ctx = provider.getContext();
          expect(ctx?.actor).toEqual(otherActor);
          expect(ctx?.request).toEqual(context.request);
        });
      });
    });

    it('should restore the outer context after withActor returns', () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { traceId: 'trace-1' },
      };

      provider.run(context, () => {
        provider.withActor(otherActor, () => {
          expect(provider.getContext()?.actor).toEqual(otherActor);
        });

        expect(provider.getContext()).toEqual(context);
      });
    });

    it('should work with no outer context', () => {
      const provider = createAsyncLocalStorageProvider();

      provider.withActor(otherActor, () => {
        const ctx = provider.getContext();
        expect(ctx?.actor).toEqual(otherActor);
        expect(ctx?.request).toBeUndefined();
      });

      expect(provider.getContext()).toBeUndefined();
    });

    it('should support nested withActor calls', () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { traceId: 'trace-1' },
      };

      const innerActor: AuditActor = { category: 'external', type: 'Webhook', id: 'hook-1' };

      provider.run(context, () => {
        provider.withActor(otherActor, () => {
          expect(provider.getContext()?.actor).toEqual(otherActor);

          provider.withActor(innerActor, () => {
            const ctx = provider.getContext();
            expect(ctx?.actor).toEqual(innerActor);
            // Request metadata is carried through every nesting level.
            expect(ctx?.request).toEqual(context.request);
          });

          expect(provider.getContext()?.actor).toEqual(otherActor);
        });
      });
    });

    it('should pass through the return value', async () => {
      const provider = createAsyncLocalStorageProvider();

      // withActor always returns a Promise; await it to get the resolved value.
      const result = await provider.withActor(otherActor, () => 'value');

      expect(result).toBe('value');
    });

    // Lazy thenables (e.g. PrismaPromise) only invoke their pipeline when .then is
    // called. The async wrapper in withActor ensures .then is called INSIDE the
    // overridden scope, so the actor read at that point is actor2, not the outer actor.
    it('plain arrow returning a lazy thenable resolves under the overridden actor', async () => {
      const provider = createAsyncLocalStorageProvider();
      const seen: string[] = [];

      // Mimics PrismaPromise: records the active actor when .then is invoked.
      const lazyOp = () => ({
        then(onFulfilled: (v: unknown) => unknown) {
          seen.push(provider.getContext()?.actor.id ?? 'none');
          return Promise.resolve().then(() => onFulfilled(undefined));
        },
      });

      const outerActor = { category: 'model' as const, type: 'User', id: 'outer-user' };
      const actor2 = { category: 'system' as const, type: 'Admin', id: 'actor-2' };
      const outerCtx: AuditContext = { actor: outerActor };

      await provider.runAsync(outerCtx, async () => {
        // Plain arrow on purpose — without the async wrapper this would capture 'outer-user'.
        await provider.withActor(actor2, () => lazyOp() as unknown as Promise<unknown>);
      });

      expect(seen).toEqual(['actor-2']);
    });

    it('plain arrow returning a lazy thenable inside runAsync resolves under the overridden context', async () => {
      const provider = createAsyncLocalStorageProvider();
      const seen: string[] = [];

      const lazyOp = () => ({
        then(onFulfilled: (v: unknown) => unknown) {
          seen.push(provider.getContext()?.actor.id ?? 'none');
          return Promise.resolve().then(() => onFulfilled(undefined));
        },
      });

      const actor2 = { category: 'system' as const, type: 'Admin', id: 'actor-2' };
      const ctx2: AuditContext = { actor: actor2 };

      await provider.runAsync(ctx2, () => lazyOp() as unknown as Promise<unknown>);

      expect(seen).toEqual(['actor-2']);
    });
  });
});
