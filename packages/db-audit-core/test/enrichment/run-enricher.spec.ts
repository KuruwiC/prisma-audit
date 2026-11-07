import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENRICHMENT_TIMEOUTS } from '../../src/constants.js';
import { runBatchEnricher, runEnricher } from '../../src/enrichment/run-enricher.js';
import { AuditReentrantWriteError, RejectedWriteError } from '../../src/policy/audit-gate.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const neverSettles = () => new Promise<never>(() => {});

describe('runEnricher', () => {
  it('should return enriched context on success', async () => {
    const config = {
      enricher: async (input: { id: string }) => ({ enriched: input.id }),
    };
    const result = await runEnricher(config, { id: 'user-1' }, null, 5000);
    expect(result).toEqual({ enriched: 'user-1' });
  });

  it('should return null when config is undefined', async () => {
    const result = await runEnricher(undefined, { id: 'user-1' }, null, 5000);
    expect(result).toBeNull();
  });

  it('should return null when enricher is undefined', async () => {
    const result = await runEnricher({} as never, { id: 'user-1' }, null, 5000);
    expect(result).toBeNull();
  });

  it('should pass projection-style meta through to the enricher', async () => {
    const meta = { aggregateType: 'User', aggregateCategory: 'model', aggregateIds: ['user-1'] };
    const enricher = vi.fn().mockResolvedValue({ enriched: true });
    const result = await runEnricher({ enricher }, { id: 'user-1' }, 'prisma-client', 5000, meta);
    expect(result).toEqual({ enriched: true });
    expect(enricher).toHaveBeenCalledWith({ id: 'user-1' }, 'prisma-client', meta);
  });

  describe("error strategy: 'throw' (default)", () => {
    it('should re-throw enricher error when onError is not set', async () => {
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
      };
      await expect(runEnricher(config, {}, null, 5000)).rejects.toThrow('enricher failed');
    });

    it("should re-throw enricher error when onError is 'throw', even with a fallback", async () => {
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: 'throw' as const,
        fallback: { default: true },
      };
      await expect(runEnricher(config, {}, null, 5000)).rejects.toThrow('enricher failed');
    });
  });

  describe("error strategy: 'log'", () => {
    it('should log warning and return fallback', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: 'log' as const,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });

    it('should return null when no fallback provided', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: 'log' as const,
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toBeNull();
    });

    it('should log and return the fallback when the enricher throws a value that cannot be converted to a string', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const thrown = Object.create(null);
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw thrown;
        },
        onError: 'log' as const,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith(
        '[db-audit-core] Enricher failed:',
        expect.objectContaining({ cause: thrown }),
      );
    });
  });

  describe("error strategy: 'ignore'", () => {
    it('should return the fallback without logging', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: 'ignore' as const,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should return null when no fallback provided', async () => {
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: 'ignore' as const,
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toBeNull();
    });
  });

  describe('error strategy: invalid value', () => {
    it("should treat a value that is not a strategy as 'log'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: 'fail' as never,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith(
        "[db-audit-core] Invalid enricher onError strategy; falling back to 'log':",
        'fail',
      );
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });
    it.each([
      ['given directly', () => Object.create(null) as never],
      ['returned by a function', () => (async () => Object.create(null)) as never],
    ])("should treat a value that cannot be converted to a string as 'log' when %s", async (_label, onErrorOf) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: onErrorOf(),
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith(
        "[db-audit-core] Invalid enricher onError strategy; falling back to 'log':",
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });
  });

  describe('error strategy: function', () => {
    it('should pass the error to the function', async () => {
      const handler = vi.fn().mockReturnValue('ignore');
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: handler,
      };
      await runEnricher(config, {}, null, 5000);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ message: 'enricher failed' }));
    });

    it("should re-throw when the function returns 'throw'", async () => {
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: () => 'throw' as const,
      };
      await expect(runEnricher(config, {}, null, 5000)).rejects.toThrow('enricher failed');
    });

    it("should log and return the fallback when the function resolves to 'log'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: async () => 'log' as const,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });

    it("should return the fallback silently when the function returns 'ignore'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: () => 'ignore' as const,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should treat a throwing function as 'log'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: () => {
          throw new Error('handler failed');
        },
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith(
        "[db-audit-core] Error in enricher onError function; falling back to 'log':",
        expect.objectContaining({ message: 'handler failed' }),
      );
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });

    it("should treat a function that throws a value that cannot be converted to a string as 'log'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: () => {
          throw Object.create(null);
        },
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith(
        "[db-audit-core] Error in enricher onError function; falling back to 'log':",
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });

    it("should treat a function that returns no valid strategy as 'log'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<{ default: boolean }> => {
          throw new Error('enricher failed');
        },
        onError: (() => 'skip') as never,
        fallback: { default: true },
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith(
        "[db-audit-core] Invalid enricher onError strategy; falling back to 'log':",
        'skip',
      );
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', expect.any(Error));
    });
  });

  describe('timeout', () => {
    it('should reject when enricher exceeds timeout, leaving no timer pending', async () => {
      vi.useFakeTimers();
      const outcome = expect(runEnricher({ enricher: neverSettles }, {}, null, 10)).rejects.toThrow('Enricher timeout');

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await outcome;

      expect(vi.getTimerCount()).toBe(0);
    });

    it('should clean up timeout when enricher completes first', async () => {
      vi.useFakeTimers();
      const config = {
        enricher: async () => ({ fast: true }),
      };
      const result = await runEnricher(config, {}, null, 5000);
      expect(result).toEqual({ fast: true });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("should log the timeout and return the fallback under the 'log' strategy", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { enricher: neverSettles, onError: 'log' as const, fallback: { timedOut: true } };
      const outcome = runEnricher(config, {}, null, 10);

      await vi.advanceTimersByTimeAsync(10);

      await expect(outcome).resolves.toEqual({ timedOut: true });
      expect(warnSpy).toHaveBeenCalledWith(
        '[db-audit-core] Enricher failed:',
        expect.objectContaining({ message: 'Enricher timeout' }),
      );
    });
  });
});

describe('runBatchEnricher', () => {
  it('should return enricher results when length matches', async () => {
    const config = {
      enricher: async (inputs: { id: string }[]) => inputs.map((i) => ({ enriched: i.id })),
    };
    const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
    expect(result).toEqual([{ enriched: 'a' }, { enriched: 'b' }]);
  });

  it("should throw when enricher returns wrong length (default 'throw' strategy)", async () => {
    const config = {
      enricher: async (_inputs: { id: string }[]) => [{ enriched: 'a' }],
    };
    await expect(runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], null, 5000)).rejects.toThrow(
      'returned 1 results for 3 inputs',
    );
  });

  it("should return nulls when enricher returns wrong length with the 'ignore' strategy", async () => {
    const config = {
      enricher: async (_inputs: { id: string }[]) => [{ enriched: 'a' }],
      onError: 'ignore' as const,
    };
    const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
    expect(result).toEqual([null, null]);
  });

  it('should return null array when no enricher configured', async () => {
    const result = await runBatchEnricher(undefined, [{ id: 'a' }], null, 5000);
    expect(result).toEqual([null]);
  });

  it('should pass projection-style meta through to the batch enricher', async () => {
    const meta = { aggregateType: 'Post', aggregateCategory: 'model', aggregateIds: ['post-1', 'post-2'] };
    const enricher = vi
      .fn()
      .mockImplementation(async (inputs: { id: string }[], _prisma: unknown, m: typeof meta) =>
        inputs.map((input, i) => ({ id: input.id, aggregateId: m.aggregateIds[i] })),
      );
    const inputs = [{ id: 'a' }, { id: 'b' }];
    const result = await runBatchEnricher({ enricher }, inputs, 'prisma-client', 5000, meta);
    expect(result).toEqual([
      { id: 'a', aggregateId: 'post-1' },
      { id: 'b', aggregateId: 'post-2' },
    ]);
    expect(enricher).toHaveBeenCalledWith(inputs, 'prisma-client', meta);
  });

  describe("error strategy: 'log'", () => {
    it('should log warning and return fallback array', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<({ ctx: string } | null)[]> => {
          throw new Error('batch failed');
        },
        onError: 'log' as const,
        fallback: [{ ctx: 'a' }, { ctx: 'b' }],
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
      expect(result).toEqual([{ ctx: 'a' }, { ctx: 'b' }]);
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Batch enricher failed:', expect.any(Error));
    });

    it('should log and return the fallback array when the enricher throws a value that cannot be converted to a string', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const thrown = Object.create(null);
      const config = {
        enricher: async (): Promise<({ ctx: string } | null)[]> => {
          throw thrown;
        },
        onError: 'log' as const,
        fallback: [{ ctx: 'a' }],
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }], null, 5000);
      expect(result).toEqual([{ ctx: 'a' }]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[db-audit-core] Batch enricher failed:',
        expect.objectContaining({ cause: thrown }),
      );
    });

    it('should return null array when no fallback provided', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<null[]> => {
          throw new Error('batch failed');
        },
        onError: 'log' as const,
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
      expect(result).toEqual([null, null]);
    });
  });

  describe("error strategy: 'ignore'", () => {
    it('should return the fallback array without logging', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<({ ctx: string } | null)[]> => {
          throw new Error('batch failed');
        },
        onError: 'ignore' as const,
        fallback: [{ ctx: 'a' }, { ctx: 'b' }],
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
      expect(result).toEqual([{ ctx: 'a' }, { ctx: 'b' }]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('error strategy: function', () => {
    it("should re-throw when the function returns 'throw'", async () => {
      const config = {
        enricher: async (): Promise<null[]> => {
          throw new Error('batch failed');
        },
        onError: () => 'throw' as const,
      };
      await expect(runBatchEnricher(config, [{ id: 'a' }], null, 5000)).rejects.toThrow('batch failed');
    });

    it("should return the fallback array silently when the function resolves to 'ignore'", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<({ ctx: string } | null)[]> => {
          throw new Error('batch failed');
        },
        onError: async () => 'ignore' as const,
        fallback: [{ ctx: 'a' }, { ctx: 'b' }],
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
      expect(result).toEqual([{ ctx: 'a' }, { ctx: 'b' }]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should treat a throwing function as 'log' and return nulls without a fallback", async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<null[]> => {
          throw new Error('batch failed');
        },
        onError: () => {
          throw new Error('handler failed');
        },
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }, { id: 'b' }], null, 5000);
      expect(result).toEqual([null, null]);
      expect(warnSpy).toHaveBeenCalledWith('[db-audit-core] Batch enricher failed:', expect.any(Error));
    });
  });

  describe('timeout', () => {
    it('should reject when batch enricher exceeds timeout, leaving no timer pending', async () => {
      vi.useFakeTimers();
      const outcome = expect(runBatchEnricher({ enricher: neverSettles }, [{ id: 'a' }], null, 10)).rejects.toThrow(
        'Enricher timeout',
      );

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await outcome;

      expect(vi.getTimerCount()).toBe(0);
    });

    it('should clean up timeout when batch enricher completes first', async () => {
      vi.useFakeTimers();
      const config = {
        enricher: async (inputs: { id: string }[]) => inputs.map((i) => ({ enriched: i.id })),
      };
      const result = await runBatchEnricher(config, [{ id: 'a' }], null, 5000);
      expect(result).toEqual([{ enriched: 'a' }]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

/** A rejection an adapter adds of its own, as the Prisma adapter's `AuditParentWriteError` is */
class AdapterRejectedWriteError extends RejectedWriteError {
  constructor() {
    super('rejected by the adapter', { modelName: 'Post', operationModelName: 'Post', operation: 'create' });
    this.name = 'AdapterRejectedWriteError';
  }
}

describe.each([
  {
    rejection: 'as reentrant',
    rejectedWrite: () =>
      new AuditReentrantWriteError({ modelName: 'Post', operationModelName: 'Post', operation: 'create' }),
  },
  { rejection: 'by an adapter of its own', rejectedWrite: () => new AdapterRejectedWriteError() },
])('a write the audit rejected before it ran, $rejection', ({ rejectedWrite }) => {
  it.each(['log', 'ignore'] as const)(
    "passes through onError '%s' when the enricher's write was rejected",
    async (onError) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = rejectedWrite();
      const rejected = async (): Promise<never> => {
        throw error;
      };

      await expect(
        runEnricher({ enricher: rejected, onError, fallback: { ctx: 'fallback' } }, {}, null, 5000),
      ).rejects.toBe(error);
      await expect(
        runBatchEnricher({ enricher: rejected, onError, fallback: [{ ctx: 'fallback' }] }, [{}], null, 5000),
      ).rejects.toBe(error);
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it('passes through an onError function whose own write was rejected, in place of the fallback to log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = rejectedWrite();
    const onError = async (): Promise<'ignore'> => {
      throw error;
    };
    const failing = async (): Promise<never> => {
      throw new Error('lookup failed');
    };

    await expect(
      runEnricher({ enricher: failing, onError, fallback: { ctx: 'fallback' } }, {}, null, 5000),
    ).rejects.toBe(error);
    await expect(runBatchEnricher({ enricher: failing, onError }, [{}], null, 5000)).rejects.toBe(error);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      enricherKind: 'single-row',
      timeoutMs: ENRICHMENT_TIMEOUTS.DEFAULT,
      run: (enricher: () => Promise<never>) => runEnricher({ enricher, onError: 'ignore' }, {}, null),
      timedOut: null,
    },
    {
      enricherKind: 'batch',
      timeoutMs: ENRICHMENT_TIMEOUTS.BATCH,
      run: (enricher: () => Promise<never>) => runBatchEnricher({ enricher, onError: 'ignore' }, [{}], null),
      timedOut: [null],
    },
  ])(
    "logs to the console the rejection of a write a $enricherKind enricher issues once it has timed out, under onError 'ignore'",
    async ({ timeoutMs, run, timedOut }) => {
      vi.useFakeTimers();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = rejectedWrite();
      const writesAfterTimeout = () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(error), timeoutMs + 100);
        });

      const result = run(writesAfterTimeout);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await expect(result).resolves.toEqual(timedOut);
      expect(consoleError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('had timed out'), error);
    },
  );
});

describe('an enricher that has timed out', () => {
  it('does not log another error an enricher rejects with once it has timed out', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failsAfterTimeout = () =>
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('lookup failed')), ENRICHMENT_TIMEOUTS.DEFAULT + 100);
      });

    const result = runEnricher({ enricher: failsAfterTimeout, onError: 'ignore' }, {}, null);
    await vi.advanceTimersByTimeAsync(ENRICHMENT_TIMEOUTS.DEFAULT + 100);

    await expect(result).resolves.toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
