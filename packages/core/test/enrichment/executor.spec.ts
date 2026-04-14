import { describe, expect, it, vi } from 'vitest';
import { executeBatchEnricherSafely, executeEnricherSafely } from '../../src/enrichment/executor.js';

const meta = { aggregateType: 'User', aggregateCategory: 'model' };

describe('executeEnricherSafely', () => {
  it('should return enriched context on success', async () => {
    const config = {
      enricher: async (input: { id: string }) => ({ enriched: input.id }),
    };
    const result = await executeEnricherSafely(config, { id: 'user-1' }, null, 5000, meta);
    expect(result).toEqual({ enriched: 'user-1' });
  });

  it('should return null when config is undefined', async () => {
    const result = await executeEnricherSafely(undefined, { id: 'user-1' }, null, 5000, meta);
    expect(result).toBeNull();
  });

  it('should return null when enricher is undefined', async () => {
    const result = await executeEnricherSafely({} as never, { id: 'user-1' }, null, 5000, meta);
    expect(result).toBeNull();
  });

  describe('error strategy: fail (default)', () => {
    it('should re-throw enricher error', async () => {
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
      };
      await expect(executeEnricherSafely(config, {}, null, 5000, meta)).rejects.toThrow('enricher failed');
    });
  });

  describe('error strategy: log', () => {
    it('should log warning and return fallback', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: 'log' as const,
        fallback: { default: true },
      };
      const result = await executeEnricherSafely(config, {}, null, 5000, meta);
      expect(result).toEqual({ default: true });
      expect(warnSpy).toHaveBeenCalledWith('[@prisma-audit] Enricher failed:', expect.any(Error));
      warnSpy.mockRestore();
    });

    it('should return null when no fallback provided', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: 'log' as const,
      };
      const result = await executeEnricherSafely(config, {}, null, 5000, meta);
      expect(result).toBeNull();
      vi.restoreAllMocks();
    });
  });

  describe('error strategy: skip', () => {
    it('should silently return null', async () => {
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: 'skip' as const,
      };
      const result = await executeEnricherSafely(config, {}, null, 5000, meta);
      expect(result).toBeNull();
    });
  });

  describe('error strategy: custom function', () => {
    it('should call custom handler and use its return value', async () => {
      const handler = vi.fn().mockReturnValue({ recovered: true });
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: handler,
      };
      const result = await executeEnricherSafely(config, {}, null, 5000, meta);
      expect(result).toEqual({ recovered: true });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ message: 'enricher failed' }));
    });

    it('should return fallback when custom handler throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('handler failed');
      });
      const config = {
        enricher: async () => {
          throw new Error('enricher failed');
        },
        onError: handler,
        fallback: { fallbackUsed: true },
      };
      const result = await executeEnricherSafely(config, {}, null, 5000, meta);
      expect(result).toEqual({ fallbackUsed: true });
      vi.restoreAllMocks();
    });
  });

  describe('timeout', () => {
    it('should reject when enricher exceeds timeout', async () => {
      const config = {
        enricher: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { done: true };
        },
      };
      await expect(executeEnricherSafely(config, {}, null, 10, meta)).rejects.toThrow('Enricher timeout');
    });

    it('should clean up timeout when enricher completes first', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const config = {
        enricher: async () => ({ fast: true }),
      };
      const result = await executeEnricherSafely(config, {}, null, 5000, meta);
      expect(result).toEqual({ fast: true });
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });
});

describe('executeBatchEnricherSafely', () => {
  it('should return enricher results when length matches', async () => {
    const config = {
      enricher: async (inputs: { id: string }[]) => inputs.map((i) => ({ enriched: i.id })),
    };
    const result = await executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }], null, 5000, meta);
    expect(result).toEqual([{ enriched: 'a' }, { enriched: 'b' }]);
  });

  it('should throw when enricher returns wrong length (default fail strategy)', async () => {
    const config = {
      enricher: async (_inputs: { id: string }[]) => [{ enriched: 'a' }],
    };
    await expect(
      executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], null, 5000, meta),
    ).rejects.toThrow('returned 1 results for 3 inputs');
  });

  it('should return fallback nulls when enricher returns wrong length with skip strategy', async () => {
    const config = {
      enricher: async (_inputs: { id: string }[]) => [{ enriched: 'a' }],
      onError: 'skip' as const,
    };
    const result = await executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }], null, 5000, meta);
    expect(result).toEqual([null, null]);
  });

  it('should return null array when no enricher configured', async () => {
    const result = await executeBatchEnricherSafely(undefined, [{ id: 'a' }], null, 5000, meta);
    expect(result).toEqual([null]);
  });

  describe('error strategy: log', () => {
    it('should log warning and return fallback array', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<({ ctx: string } | null)[]> => {
          throw new Error('batch failed');
        },
        onError: 'log' as const,
        fallback: [{ ctx: 'a' }, { ctx: 'b' }],
      };
      const result = await executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }], null, 5000, meta);
      expect(result).toEqual([{ ctx: 'a' }, { ctx: 'b' }]);
      expect(warnSpy).toHaveBeenCalledWith('[@prisma-audit] Batch enricher failed:', expect.any(Error));
      warnSpy.mockRestore();
    });

    it('should return null array when no fallback provided', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = {
        enricher: async (): Promise<null[]> => {
          throw new Error('batch failed');
        },
        onError: 'log' as const,
      };
      const result = await executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }], null, 5000, meta);
      expect(result).toEqual([null, null]);
      vi.restoreAllMocks();
    });
  });

  describe('error strategy: custom function', () => {
    it('should use custom handler return value when it returns array', async () => {
      const handler = vi.fn().mockReturnValue([{ recovered: 'a' }, { recovered: 'b' }]);
      const config = {
        enricher: async (): Promise<({ recovered: string } | null)[]> => {
          throw new Error('batch failed');
        },
        onError: handler,
      };
      const result = await executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }], null, 5000, meta);
      expect(result).toEqual([{ recovered: 'a' }, { recovered: 'b' }]);
    });

    it('should return null array when custom handler throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('handler failed');
      });
      const config = {
        enricher: async (): Promise<null[]> => {
          throw new Error('batch failed');
        },
        onError: handler,
      };
      const result = await executeBatchEnricherSafely(config, [{ id: 'a' }, { id: 'b' }], null, 5000, meta);
      expect(result).toEqual([null, null]);
      vi.restoreAllMocks();
    });
  });

  describe('timeout', () => {
    it('should reject when batch enricher exceeds timeout', async () => {
      const config = {
        enricher: async (inputs: { id: string }[]) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return inputs.map(() => ({ done: true }));
        },
      };
      await expect(executeBatchEnricherSafely(config, [{ id: 'a' }], null, 10, meta)).rejects.toThrow(
        'Enricher timeout',
      );
    });

    it('should clean up timeout when batch enricher completes first', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const config = {
        enricher: async (inputs: { id: string }[]) => inputs.map((i) => ({ enriched: i.id })),
      };
      const result = await executeBatchEnricherSafely(config, [{ id: 'a' }], null, 5000, meta);
      expect(result).toEqual([{ enriched: 'a' }]);
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });
});
