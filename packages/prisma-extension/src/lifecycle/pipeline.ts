/**
 * Lifecycle Pipeline Pattern Implementation
 *
 * Provides a type-safe context transformation pipeline for audit logging.
 * Each stage transforms the context from one type to another, adding properties
 * while preserving existing ones.
 *
 * Pipeline Flow:
 * InitialContext → PreparedContext → ExecutedContext → EnrichedContext → FinalContext
 *
 * @module lifecycle/pipeline
 */

import type { LifecycleStage } from './types.js';

/**
 * Executes lifecycle stages in sequence, transforming context step by step.
 *
 * Each stage receives the output of the previous stage, creating a type-safe
 * transformation chain. Errors thrown in any stage propagate to the caller.
 *
 * @typeParam TInitial - Initial context type (pipeline input)
 * @typeParam TFinal - Final context type (pipeline output)
 *
 * @param initialContext - Starting context
 * @param stages - Stages to execute in order
 *
 * @returns Promise resolving to final transformed context
 *
 * @example
 * ```typescript
 * // Simple 3-stage pipeline
 * type Step1 = { value: number };
 * type Step2 = Step1 & { doubled: number };
 * type Step3 = Step2 & { tripled: number };
 *
 * const stage1: LifecycleStage<Step1, Step2> = async (ctx) => ({
 *   ...ctx,
 *   doubled: ctx.value * 2,
 * });
 *
 * const stage2: LifecycleStage<Step2, Step3> = async (ctx) => ({
 *   ...ctx,
 *   tripled: ctx.value * 3,
 * });
 *
 * const result = await runLifecyclePipeline<Step1, Step3>(
 *   { value: 10 },
 *   [stage1, stage2]
 * );
 * // result: { value: 10, doubled: 20, tripled: 30 }
 * ```
 *
 * @remarks
 * Uses `any` for stage array type to work around TypeScript's contravariance limitations.
 * Type safety is ensured by proper stage definitions at call sites.
 */
export const runLifecyclePipeline = async <TInitial, TFinal>(
  initialContext: TInitial,
  // biome-ignore lint/suspicious/noExplicitAny: TypeScript contravariance limitation workaround
  stages: ReadonlyArray<LifecycleStage<any, any>>,
): Promise<TFinal> => {
  // biome-ignore lint/suspicious/noExplicitAny: Type safety ensured by stage definitions
  let currentContext: any = initialContext;

  for (const stage of stages) {
    currentContext = await stage(currentContext);
  }

  return currentContext as TFinal;
};
