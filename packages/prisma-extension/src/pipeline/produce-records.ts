/**
 * Audit record production
 *
 * The one path from mutation events to audit records: resolve the events through the user's
 * id resolvers and enrichers, report each row a resolver failed for as `aggregate-resolution`,
 * then compose the records. The database handle those callbacks receive is the scope's, looked
 * up when each one runs: the client of the transaction the operation runs in when there is one,
 * else the base client, so a callback inside a transaction reads that transaction's writes.
 */

import type { AuditRecord, ComposeConfig, FailureSink, MutationEvent, ResolveConfig } from '@kuruwic/db-audit-core';
import { compose, resolve } from '@kuruwic/db-audit-core';
import type { ExecutionScope } from './execution-scope.js';

export interface RecordProducerConfig {
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly failureSink: Pick<FailureSink, 'reportResolverFailures'>;
}

export type RecordProducer = (events: readonly MutationEvent[], scope: ExecutionScope) => Promise<AuditRecord[]>;

export const createRecordProducer = (config: RecordProducerConfig): RecordProducer => {
  return async (events, scope) => {
    const { resolved, failures } = await resolve(events, scope.auditContext, config.resolveConfig, () => scope.handle);
    await config.failureSink.reportResolverFailures(failures);
    return compose(resolved, { auditContext: scope.auditContext, config: config.composeConfig }, new Date());
  };
};
