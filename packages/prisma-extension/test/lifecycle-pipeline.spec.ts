/**
 * Tests for Lifecycle Pipeline Pattern
 *
 * This test suite validates the type-safe context transformation pipeline.
 * Tests follow the Red-Green-Refactor TDD approach.
 *
 * @module lifecycle-pipeline.spec
 */

import { describe, expect, it, vi } from 'vitest';
import { runLifecyclePipeline } from '../src/lifecycle/pipeline.js';
import type { LifecycleStage } from '../src/lifecycle/types.js';

describe('runLifecyclePipeline', () => {
  describe('Empty pipeline', () => {
    it('should return initial context when given empty stages array', async () => {
      // Arrange
      const initialContext = { value: 42 };
      const stages: ReadonlyArray<LifecycleStage<unknown, unknown>> = [];

      // Act
      const result = await runLifecyclePipeline(initialContext, stages);

      // Assert
      expect(result).toEqual(initialContext);
      expect(result).toBe(initialContext); // Same reference
    });
  });

  describe('Single stage', () => {
    it('should execute a single stage and return transformed result', async () => {
      // Arrange
      type Input = { value: number };
      type Output = { value: number; doubled: number };

      const initialContext: Input = { value: 42 };
      const stage: LifecycleStage<Input, Output> = async (ctx) => ({
        ...ctx,
        doubled: ctx.value * 2,
      });
      // biome-ignore lint/suspicious/noExplicitAny: Pipeline requires any for dynamic stage composition
      const stages: ReadonlyArray<LifecycleStage<any, any>> = [stage];

      // Act
      const result = await runLifecyclePipeline<Input, Output>(initialContext, stages);

      // Assert
      expect(result).toEqual({
        value: 42,
        doubled: 84,
      });
    });

    it('should call the stage function once', async () => {
      // Arrange
      const initialContext = { value: 1 };
      const stageFn = vi.fn(async (ctx: unknown) => ({
        ...(ctx as Record<string, unknown>),
        processed: true,
      }));
      const stages: ReadonlyArray<LifecycleStage<unknown, unknown>> = [stageFn];

      // Act
      await runLifecyclePipeline(initialContext, stages);

      // Assert
      expect(stageFn).toHaveBeenCalledTimes(1);
      expect(stageFn).toHaveBeenCalledWith(initialContext);
    });
  });

  describe('Multiple stages composition', () => {
    it('should execute three stages sequentially and pass output to next stage', async () => {
      // Arrange
      type Step1 = { value: number };
      type Step2 = Step1 & { doubled: number };
      type Step3 = Step2 & { tripled: number };
      type Step4 = Step3 & { total: number };

      const initialContext: Step1 = { value: 10 };

      const stage1: LifecycleStage<Step1, Step2> = async (ctx) => ({
        ...ctx,
        doubled: ctx.value * 2,
      });

      const stage2: LifecycleStage<Step2, Step3> = async (ctx) => ({
        ...ctx,
        tripled: ctx.value * 3,
      });

      const stage3: LifecycleStage<Step3, Step4> = async (ctx) => ({
        ...ctx,
        total: ctx.doubled + ctx.tripled,
      });

      // biome-ignore lint/suspicious/noExplicitAny: Pipeline requires any for dynamic stage composition
      const stages: ReadonlyArray<LifecycleStage<any, any>> = [stage1, stage2, stage3];

      // Act
      const result = await runLifecyclePipeline<Step1, Step4>(initialContext, stages);

      // Assert
      expect(result).toEqual({
        value: 10,
        doubled: 20,
        tripled: 30,
        total: 50,
      });
    });

    it('should call all stages in order with correct inputs', async () => {
      // Arrange
      const calls: string[] = [];

      const stage1 = vi.fn(async (ctx: unknown) => {
        calls.push('stage1');
        return { ...(ctx as Record<string, unknown>), step1: true };
      });

      const stage2 = vi.fn(async (ctx: unknown) => {
        calls.push('stage2');
        return { ...(ctx as Record<string, unknown>), step2: true };
      });

      const stage3 = vi.fn(async (ctx: unknown) => {
        calls.push('stage3');
        return { ...(ctx as Record<string, unknown>), step3: true };
      });

      const initialContext = { value: 1 };
      const stages: ReadonlyArray<LifecycleStage<unknown, unknown>> = [stage1, stage2, stage3];

      // Act
      await runLifecyclePipeline(initialContext, stages);

      // Assert
      expect(calls).toEqual(['stage1', 'stage2', 'stage3']);
      expect(stage1).toHaveBeenCalledWith(initialContext);
      expect(stage2).toHaveBeenCalledWith({ value: 1, step1: true });
      expect(stage3).toHaveBeenCalledWith({ value: 1, step1: true, step2: true });
    });
  });

  describe('Error handling', () => {
    it('should propagate error when a stage throws', async () => {
      // Arrange
      const initialContext = { value: 1 };
      const errorMessage = 'Stage failed';

      const stage1 = async (ctx: unknown) => ({ ...(ctx as Record<string, unknown>), step1: true });
      const stage2 = async (_ctx: unknown): Promise<unknown> => {
        throw new Error(errorMessage);
      };
      const stage3 = async (ctx: unknown) => ({ ...(ctx as Record<string, unknown>), step3: true });

      const stages: ReadonlyArray<LifecycleStage<unknown, unknown>> = [stage1, stage2, stage3];

      // Act & Assert
      await expect(runLifecyclePipeline(initialContext, stages)).rejects.toThrow(errorMessage);
    });

    it('should not execute subsequent stages after error', async () => {
      // Arrange
      const initialContext = { value: 1 };
      const stage1 = vi.fn(async (ctx: unknown) => ({
        ...(ctx as Record<string, unknown>),
        step1: true,
      }));
      const stage2 = vi.fn(async (_ctx: unknown): Promise<unknown> => {
        throw new Error('Stage 2 error');
      });
      const stage3 = vi.fn(async (ctx: unknown) => ({
        ...(ctx as Record<string, unknown>),
        step3: true,
      }));

      const stages: ReadonlyArray<LifecycleStage<unknown, unknown>> = [stage1, stage2, stage3];

      // Act
      try {
        await runLifecyclePipeline(initialContext, stages);
      } catch {
        // Expected to throw
      }

      // Assert
      expect(stage1).toHaveBeenCalledTimes(1);
      expect(stage2).toHaveBeenCalledTimes(1);
      expect(stage3).not.toHaveBeenCalled(); // Should not be called
    });
  });

  describe('Async behavior', () => {
    it('should handle async stages correctly', async () => {
      // Arrange
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const stage1 = async (ctx: unknown) => {
        await delay(10);
        return { ...(ctx as Record<string, unknown>), step1: true };
      };

      const stage2 = async (ctx: unknown) => {
        await delay(10);
        return { ...(ctx as Record<string, unknown>), step2: true };
      };

      const initialContext = { value: 1 };
      const stages: ReadonlyArray<LifecycleStage<unknown, unknown>> = [stage1, stage2];

      // Act
      const result = await runLifecyclePipeline(initialContext, stages);

      // Assert
      expect(result).toEqual({ value: 1, step1: true, step2: true });
    });
  });
});
