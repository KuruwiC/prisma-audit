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
 * @param db - Database handle passed through to the enricher
 * @returns Enriched actor context or null if no enricher configured
 *
 * @example
 * ```typescript
 * const enrichedActor = await enrichActorContext(
 *   { actor: { id: '123', role: 'admin' } },
 *   {
 *     enricher: async (actor, db) => {
 *       const user = await db.users.find({ id: actor.id });
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
 *   db
 * );
 * ```
 */
export const enrichActorContext = async (
  auditContext: AuditContext,
  actorEnricherConfig: ActorEnricherConfig,
  db: unknown,
): Promise<unknown> => {
  if (!actorEnricherConfig) {
    return null;
  }

  return await executeEnricherSafely(actorEnricherConfig, auditContext.actor, db);
};
