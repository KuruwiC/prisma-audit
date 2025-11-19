/**
 * Enrichment module - Public API for enriching audit log data with additional context (actor, entity, aggregate)
 *
 * @example
 * ```typescript
 * import {
 *   enrichActorContext,
 *   batchEnrichEntityContexts,
 *   type EnricherConfig
 * } from '@kuruwic/prisma-audit/enrichment';
 *
 * const actorEnricher: EnricherConfig<Actor, EnrichedActor> = {
 *   enricher: async (actor, prisma) => {
 *     const user = await prisma.user.findUnique({ where: { id: actor.id } });
 *     return { ...actor, fullName: user.name };
 *   },
 *   onError: 'log',
 *   fallback: null
 * };
 * ```
 */

// Actor enrichment
export { enrichActorContext } from './actor.js';
// Batch enrichment for entities and aggregates
export { batchEnrichAggregateContexts, batchEnrichEntityContexts } from './batch.js';
// Core executor for safe enricher execution
export { executeBatchEnricherSafely, executeEnricherSafely } from './executor.js';
// Type definitions
export type {
  ActorEnricherConfig,
  EnricherConfig,
  EnricherErrorStrategy,
  EntityEnricherConfig,
} from './types.js';
