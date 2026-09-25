/**
 * Resolution configuration
 *
 * Describes, per entity, how a mutation event's entity id, aggregate roots and contexts are
 * resolved. The id resolver and the enrichers are user callbacks that receive the database
 * handle through a thunk evaluated at call time, so reads inside a transaction see that
 * transaction's writes.
 */

import type { AggregateIdResolver, AggregateRoot, SelfProjectionConfig } from '../aggregate/types.js';
import type { GlobalContextEnricherConfig } from '../config.types.js';
import type { AggregateContextEnricherConfig, EntityEnricherConfig } from '../enrichment/types.js';

export interface EntityResolveConfig<TDbHandle = unknown> {
  readonly category: string;
  readonly type: string;
  readonly idResolver: AggregateIdResolver<Record<string, unknown>, TDbHandle>;
  readonly aggregates: readonly AggregateRoot[];
  readonly self?: SelfProjectionConfig;
  readonly context?: EntityEnricherConfig<TDbHandle>;
  readonly aggregateContext?: AggregateContextEnricherConfig<TDbHandle>;
}

export interface ResolveConfig<TModelName extends string = string, TDbHandle = unknown> {
  /** Entity configuration of a written model, or undefined when the model is not audited. */
  readonly entity: (model: TModelName) => EntityResolveConfig<TDbHandle> | undefined;
  /** Entity configuration of an aggregate root, looked up by its type and category. */
  readonly rootEntity: (type: string, category: string) => EntityResolveConfig<TDbHandle> | undefined;
  readonly actor?: GlobalContextEnricherConfig<unknown, unknown, TDbHandle>['actor'];
}
