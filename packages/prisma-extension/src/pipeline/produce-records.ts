/**
 * Audit record production
 *
 * The one path from mutation events to audit records: resolve the events through the user's
 * id resolvers and enrichers, then compose the records. The database handle those callbacks
 * receive is looked up when each one runs: the client of the transaction the operation runs in
 * when there is one, else the base client, so a callback inside a transaction reads that
 * transaction's writes.
 */

import type { AuditContext, ComposeConfig, MutationEvent, ResolveConfig } from '@kuruwic/prisma-audit-core';
import { compose, getRuntimeContext, resolve } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess } from '../internal-types.js';
import type { AuditLogData } from '../types.js';

export interface RecordProducerConfig {
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
}

export type RecordProducer = (events: readonly MutationEvent[], auditContext: AuditContext) => Promise<AuditLogData[]>;

export const createRecordProducer = (
  config: RecordProducerConfig,
  baseClient: PrismaClientWithDynamicAccess,
): RecordProducer => {
  const read = (): unknown => getRuntimeContext()?.transaction?.client ?? baseClient;

  return async (events, auditContext) => {
    const resolved = await resolve(events, auditContext, config.resolveConfig, read);
    return compose(resolved, { auditContext, config: config.composeConfig }, new Date());
  };
};
