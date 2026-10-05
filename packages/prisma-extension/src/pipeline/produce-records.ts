/**
 * Audit record production
 *
 * The one path from mutation events to audit records: read the omitted fields the entities audit
 * for the rows the write left (`omitted-fields-after-write.ts`), resolve the events through the
 * user's id resolvers and enrichers, report each row a resolver failed for as `id-resolver-call`,
 * leave each row to the columns a record stores (`audited-columns.ts`), then compose the records.
 * The database handle those callbacks receive is the scope's, looked up when each one runs: the
 * client of the transaction the operation runs in when there is one, else the base client, so a
 * callback inside a transaction reads that transaction's writes. The resolvers see the omitted
 * fields an entity audits, so a foreign key the client hides resolves once its entity lists it.
 */

import type { AuditRecord, ComposeConfig, FailureSink, MutationEvent, ResolveConfig } from '@kuruwic/db-audit-core';
import { compose, resolve } from '@kuruwic/db-audit-core';
import type { WidenedColumns } from '../utils/audited-selection.js';
import { keepAuditedColumns } from './audited-columns.js';
import type { ExecutionScope } from './execution-scope.js';
import { type OmittedFieldReadDependencies, readOmittedFieldsAfterWrite } from './omitted-fields-after-write.js';

export interface RecordProducerConfig {
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly omittedFieldReads: OmittedFieldReadDependencies;
  readonly failureSink: Pick<FailureSink, 'reportResolverFailures'>;
}

/** @param widened - The columns the operation's widened `select` added (see `injectAuditedSelection`) */
export type RecordProducer = (
  events: readonly MutationEvent[],
  scope: ExecutionScope,
  widened: WidenedColumns,
) => Promise<AuditRecord[]>;

export const createRecordProducer = (config: RecordProducerConfig): RecordProducer => {
  return async (events, scope, widened) => {
    const written = await readOmittedFieldsAfterWrite(events, scope.handle, config.omittedFieldReads);
    const { resolved, failures } = await resolve(written, scope.auditContext, config.resolveConfig, () => scope.handle);
    await config.failureSink.reportResolverFailures(failures);
    const stored = resolved.map((event) => keepAuditedColumns(event, widened));
    return compose(stored, { auditContext: scope.auditContext, config: config.composeConfig }, new Date());
  };
};
