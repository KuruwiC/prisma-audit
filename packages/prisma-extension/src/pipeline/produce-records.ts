/**
 * Audit record production
 *
 * The one path from mutation events to audit records: resolve the events through the user's
 * id resolvers and enrichers, report each row a resolver failed for as `aggregate-resolution`,
 * then compose the records. The database handle those callbacks receive is the scope's, looked
 * up when each one runs: the client of the transaction the operation runs in when there is one,
 * else the base client, so a callback inside a transaction reads that transaction's writes.
 */

import type { AuditRecord, ComposeConfig, MutationEvent, ResolveConfig, ResolverFailure } from '@kuruwic/db-audit-core';
import { compose, resolve } from '@kuruwic/db-audit-core';
import type { FailureSink } from '../failure-sink.js';
import type { AuditErrorContext } from '../types.js';
import type { ExecutionScope } from './execution-scope.js';

export interface RecordProducerConfig {
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly failureSink: Pick<FailureSink, 'notify'>;
}

export type RecordProducer = (events: readonly MutationEvent[], scope: ExecutionScope) => Promise<AuditRecord[]>;

const resolverFailureContext = ({ event, resolver, error }: ResolverFailure): AuditErrorContext => ({
  phase: 'aggregate-resolution',
  modelName: event.model,
  operation: event.origin.op,
  params: { identity: event.identity, resolver },
  error,
});

export const createRecordProducer = (config: RecordProducerConfig): RecordProducer => {
  return async (events, scope) => {
    const { resolved, failures } = await resolve(events, scope.auditContext, config.resolveConfig, () => scope.handle);
    for (const failure of failures) {
      await config.failureSink.notify(resolverFailureContext(failure));
    }
    return compose(resolved, { auditContext: scope.auditContext, config: config.composeConfig }, new Date());
  };
};
