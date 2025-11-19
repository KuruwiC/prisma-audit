/** Actor enrichment functions for enriching actor context with additional database data */

import type { AuditContext } from '../types.js';
import { executeEnricherSafely } from './executor.js';
import type { ActorEnricherConfig } from './types.js';

/**
 * Enrich actor context from AuditContext
 *
 * Enriches minimal actor information (e.g., user ID) with additional context stored in the audit log's `actor` field. Returns null if no enricher configured.
 *
 * @param auditContext - Audit context containing actor information
 * @param actorEnricherConfig - Actor enricher configuration
 * @param basePrisma - Base Prisma client for database access
 * @returns Enriched actor context or null if no enricher configured
 *
 * @example
 * ```typescript
 * const enrichedActor = await enrichActorContext(
 *   { actor: { id: '123', role: 'admin' } },
 *   {
 *     enricher: async (actor, prisma) => {
 *       const user = await prisma.user.findUnique({ where: { id: actor.id } });
 *       return {
 *         id: actor.id,
 *         fullName: user?.name ?? 'Unknown',
 *         email: user?.email,
 *         department: user?.department
 *       };
 *     },
 *     onError: 'log',
 *     fallback: null
 *   },
 *   prisma
 * );
 * ```
 */
export const enrichActorContext = async (
  auditContext: AuditContext,
  actorEnricherConfig: ActorEnricherConfig,
  basePrisma: unknown,
): Promise<unknown> => {
  if (!actorEnricherConfig) {
    return null;
  }

  // Actor enrichment uses fixed meta values
  const meta = {
    aggregateType: 'Actor',
    aggregateCategory: 'system',
  };

  return await executeEnricherSafely(actorEnricherConfig, auditContext.actor, basePrisma, undefined, meta);
};
