import { describe, expect, it } from 'vitest';
import { createAsyncLocalStorageProvider } from '../src/context-provider.js';
import type { AuditActor, AuditContext } from '../src/types.js';
import { deferred } from './support/deferred.js';

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
    const resumed = deferred();

    const running = provider.runAsync(context, async () => {
      await resumed.promise;

      const ctx = provider.getContext();
      expect(ctx).toEqual(context);
      return 'async-success';
    });
    // Resumed from outside the context, after the callback has suspended
    resumed.resolve();
    const result = await running;

    expect(result).toBe('async-success');
    expect(provider.getContext()).toBeUndefined();
  });

  it('should propagate context across nested async calls', async () => {
    const provider = createAsyncLocalStorageProvider();

    const context: AuditContext = {
      actor: { category: 'model', type: 'Admin', id: 'admin-456' },
      request: { tenantId: 'tenant-789' },
    };

    const resumed = deferred();
    const nestedAsyncFunction = async () => {
      await resumed.promise;
      return provider.getContext();
    };

    const running = provider.runAsync(context, async () => {
      const ctx1 = provider.getContext();
      expect(ctx1).toEqual(context);

      const ctx2 = await nestedAsyncFunction();
      expect(ctx2).toEqual(context);

      const ctx3 = provider.getContext();
      expect(ctx3).toEqual(context);
    });
    resumed.resolve();
    await running;
  });

  // Resuming in either order fails a provider that answers with one shared context: the one started
  // last (a stack) fails the first order, the one started first (a queue) the second.
  it.each([
    { order: 'the one started first resumes first', resumeOrder: [0, 1] },
    { order: 'the one started last resumes first', resumeOrder: [1, 0] },
  ])('should isolate contexts in parallel async operations when $order', async ({ resumeOrder }) => {
    const provider = createAsyncLocalStorageProvider();

    const contexts: AuditContext[] = [
      { actor: { category: 'model', type: 'User', id: 'user-1' } },
      { actor: { category: 'model', type: 'User', id: 'user-2' } },
    ];
    const resumes = contexts.map(() => deferred());

    const runs = contexts.map((context, index) =>
      provider.runAsync(context, async () => {
        await resumes[index]?.promise;
        return provider.getContext();
      }),
    );

    const seen: Array<AuditContext | undefined> = [];
    for (const index of resumeOrder) {
      resumes[index]?.resolve();
      seen[index] = await runs[index];
    }

    expect(seen).toEqual(contexts);
    expect(provider.getContext()).toBeUndefined();
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

    const resumed = deferred();

    const running = provider.runAsync(context, async () => {
      await resumed.promise;
      throw new Error('Async test error');
    });
    resumed.resolve();

    await expect(running).rejects.toThrow('Async test error');

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

    it('should override only the actor and preserve request metadata', async () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { ipAddress: '192.168.1.1', traceId: 'trace-1' },
      };

      await provider.runAsync(context, async () => {
        await provider.withActor(otherActor, () => {
          const ctx = provider.getContext();
          expect(ctx?.actor).toEqual(otherActor);
          expect(ctx?.request).toEqual(context.request);
        });
      });
    });

    it('should restore the outer context after withActor returns', async () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { traceId: 'trace-1' },
      };

      await provider.runAsync(context, async () => {
        await provider.withActor(otherActor, () => {
          expect(provider.getContext()?.actor).toEqual(otherActor);
        });

        expect(provider.getContext()).toEqual(context);
      });
    });

    it('should work with no outer context', async () => {
      const provider = createAsyncLocalStorageProvider();

      await provider.withActor(otherActor, () => {
        const ctx = provider.getContext();
        expect(ctx?.actor).toEqual(otherActor);
        expect(ctx?.request).toBeUndefined();
      });

      expect(provider.getContext()).toBeUndefined();
    });

    it('should support nested withActor calls', async () => {
      const provider = createAsyncLocalStorageProvider();

      const context: AuditContext = {
        actor: { category: 'model', type: 'User', id: 'user-123' },
        request: { traceId: 'trace-1' },
      };

      const innerActor: AuditActor = { category: 'external', type: 'Webhook', id: 'hook-1' };

      await provider.runAsync(context, async () => {
        await provider.withActor(otherActor, async () => {
          expect(provider.getContext()?.actor).toEqual(otherActor);

          await provider.withActor(innerActor, () => {
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

    it('rejects with the error of a callback that rejects, and leaves no actor override behind', async () => {
      const provider = createAsyncLocalStorageProvider();
      const failure = new Error('write failed');

      await provider.runAsync({ actor: { category: 'model', type: 'User', id: 'outer-user' } }, async () => {
        await expect(provider.withActor(otherActor, () => Promise.reject(failure))).rejects.toBe(failure);

        expect(provider.getContext()?.actor.id).toBe('outer-user');
      });
    });

    it('rejects with the error of a callback that throws synchronously', async () => {
      const provider = createAsyncLocalStorageProvider();
      const failure = new Error('callback threw');

      await expect(
        provider.withActor(otherActor, () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
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
