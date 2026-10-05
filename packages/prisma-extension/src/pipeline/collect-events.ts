/**
 * Mutation event collection
 *
 * Turns what an executed Prisma operation left behind (its result, the before-state fetched
 * ahead of it, the pre-fetched nested records) into the mutation events that core resolves and
 * composes into audit records: one for the top-level row plus one per nested record of a single
 * operation, or one per row of a batch operation.
 *
 * The row handed to an entity's resolvers and enrichers is `after` when present, else `before`.
 * A delete stores no after state, and its `to()` roots are resolved from `after` and, when its
 * before state is captured, from the row before the write too, so a delete event carries in
 * `after` only what its before state does not show: the row Prisma returned for the deleted record
 * when it was not read before (top level), the primary-key record rebuilt from the operation (a
 * nested delete without a before-state), or the row a nested write linked to the parent it was
 * then deleted from.
 */

import type { BeforeState, MutationAction, MutationEvent } from '@kuruwic/db-audit-core';
import {
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../grammar/nested-operations.js';
import { AUDIT_ACTION, type AuditAction, BATCH_TO_SINGULAR_ACTION } from '../grammar/operations.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { collectNestedEvents, type NestedEventCollectorDependencies } from '../nested/events/collect-nested-events.js';
import { identityOf, toMutationAction } from '../nested/events/event-fields.js';
import type { NestedWriteSets } from '../nested/events/write-set.js';
import type { LinkReads } from '../nested/pre-fetch/link-rows.js';
import type { PreExistingRows } from '../nested/pre-fetch/pre-existing-rows.js';
import type { SchemaMetadata } from '../schema/types.js';
import { beforeStateOf } from '../utils/before-state.js';
import { executedUpsertBranch } from './before-state.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

const toRow = (result: unknown): Row => {
  if (!isRow(result)) {
    throw new Error('[@prisma-audit] Operation result must be an object');
  }
  return result;
};

export interface SingleOperationOutcome {
  readonly modelName: string;
  readonly action: AuditAction;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
  readonly beforeState: BeforeState;
  readonly nestedPreFetchResults: NestedPreFetchResults;
  /** The nested operations the operation executed, resolved before it ran */
  readonly nestedOperations: readonly NestedOperationInfo[];
  readonly writeSets: NestedWriteSets;
  readonly preExistingRows: PreExistingRows;
  readonly linkReads: LinkReads;
  /** Client the operation ran on; reads the nested rows the result did not include */
  readonly client: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
}

export type EventCollectorDependencies = NestedEventCollectorDependencies;

/**
 * The top-level row carries the before state as read: captured, none, or unavailable when the
 * read failed. An upsert whose read failed yields no event at all: a failed read cannot tell an
 * absent row from an existing one, so neither the top-level action nor the nested writes of the
 * executed branch can be told (the read already reported its failure).
 */
export const collectSingleOperationEvents = async (
  outcome: SingleOperationOutcome,
  deps: EventCollectorDependencies,
): Promise<MutationEvent[]> => {
  const { modelName, action, args, result, beforeState, client } = outcome;
  const { nestedPreFetchResults, nestedOperations, writeSets, preExistingRows, linkReads } = outcome;

  if (action === AUDIT_ACTION.UPSERT && executedUpsertBranch(action, beforeState) === undefined) {
    return [];
  }

  const row = toRow(result);
  const topLevel: MutationEvent = {
    model: modelName,
    identity: identityOf(row, getPrimaryKeyConstraint(deps.schemaMetadata, modelName)?.fields, {
      model: modelName,
      path: '',
    }),
    action: toMutationAction(action, beforeState),
    before: beforeState,
    after: action === AUDIT_ACTION.DELETE && beforeState.kind === 'captured' ? undefined : row,
    origin: { path: '', op: action },
  };

  const nested = await collectNestedEvents(
    {
      modelName,
      args,
      result,
      topLevelBefore: beforeState,
      client,
      nestedPreFetchResults,
      nestedOperations,
      writeSets,
      preExistingRows,
      linkReads,
    },
    deps,
  );

  return [topLevel, ...nested];
};

export interface BatchOperationOutcome {
  readonly modelName: string;
  readonly action: AuditAction;
  readonly rows: ReadonlyArray<Row>;
  /** Before state of the row at the same index in `rows`; absent for createMany */
  readonly beforeStates?: ReadonlyArray<Row | null>;
}

const toSingularAction = (action: AuditAction): MutationAction => {
  const singular = BATCH_TO_SINGULAR_ACTION[action as keyof typeof BATCH_TO_SINGULAR_ACTION];
  if (!singular) {
    throw new Error(`Unknown batch action: ${action}`);
  }
  return singular;
};

export const collectBatchOperationEvents = (
  outcome: BatchOperationOutcome,
  schemaMetadata: SchemaMetadata,
): MutationEvent[] => {
  const { modelName, action, rows, beforeStates } = outcome;
  const singularAction = toSingularAction(action);
  const pkFields = getPrimaryKeyConstraint(schemaMetadata, modelName)?.fields;

  // A batch operation reads every row it updates or deletes, so a row without a before row had none
  return rows.map((row, index) => ({
    model: modelName,
    identity: identityOf(row, pkFields, { model: modelName, path: '' }),
    action: singularAction,
    before: beforeStateOf(beforeStates?.[index]),
    after: singularAction === 'delete' ? undefined : row,
    origin: { path: '', op: action },
  }));
};
