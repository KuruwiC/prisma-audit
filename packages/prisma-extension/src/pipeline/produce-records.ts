/**
 * Audit record production
 *
 * The one path from mutation events to audit records: resolve the events through the user's
 * id resolvers and enrichers, then compose the records. The database handle those callbacks
 * receive is the scope's, looked up when each one runs: the client of the transaction the
 * operation runs in when there is one, else the base client, so a callback inside a
 * transaction reads that transaction's writes.
 */

import type { ComposeConfig, MutationEvent, ResolveConfig } from '@kuruwic/prisma-audit-core';
import { compose, resolve } from '@kuruwic/prisma-audit-core';
import type { AuditLogData } from '../types.js';
import type { ExecutionScope } from './execution-scope.js';

export interface RecordProducerConfig {
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
}

export type RecordProducer = (events: readonly MutationEvent[], scope: ExecutionScope) => Promise<AuditLogData[]>;

export const createRecordProducer = (config: RecordProducerConfig): RecordProducer => {
  return async (events, scope) => {
    const resolved = await resolve(events, scope.auditContext, config.resolveConfig, () => scope.handle);
    return compose(resolved, { auditContext: scope.auditContext, config: config.composeConfig }, new Date());
  };
};
