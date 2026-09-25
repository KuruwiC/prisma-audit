/**
 * Mutation event collection
 *
 * Turns what an executed Prisma operation left behind (its result, the before-state fetched
 * ahead of it, the pre-fetched nested records) into the mutation events that core resolves and
 * composes into audit records: one for the top-level row plus one per nested record of a single
 * operation, or one per row of a batch operation.
 *
 * The row handed to an entity's resolvers and enrichers is `after` when present, else `before`.
 * A delete stores no after state, so a delete event may carry in `after` the row Prisma returned
 * for the deleted record (top level) or the primary-key record rebuilt from the operation (a
 * nested delete without a before-state) without either reaching the audit row.
 */

import type { AuditAction, MutationAction, MutationEvent } from '@kuruwic/prisma-audit-core';
import { AUDIT_ACTION, BATCH_TO_SINGULAR_ACTION } from '@kuruwic/prisma-audit-core';
import {
  getPrimaryKeyConstraint,
  type NestedPreFetchResults,
  type UpsertBranch,
} from '../grammar/nested-operations.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import {
  collectNestedEvents,
  type NestedEventCollectorDependencies,
} from '../lifecycle/nested-handlers/collect-nested-events.js';
import type { BeforeStateResult } from '../lifecycle/types.js';
import type { SchemaMetadata } from '../schema/types.js';
import { identityOf, toMutationAction } from './event-fields.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

const toRow = (result: unknown): Row => {
  if (!isRow(result)) {
    throw new Error('[@prisma-audit] Operation result must be an object');
  }
  return result;
};

/**
 * The branch a top-level upsert executed: `update` when its before-state was found, `create`
 * when the row did not exist. Undefined when the fetch failed (the branch is unknown) or the
 * operation is not an upsert.
 */
const upsertBranchOf = (action: AuditAction, beforeStateResult: BeforeStateResult): UpsertBranch | undefined => {
  if (action !== AUDIT_ACTION.UPSERT) {
    return undefined;
  }
  switch (beforeStateResult._tag) {
    case 'found':
      return 'update';
    case 'notFound':
      return 'create';
    case 'error':
    case 'notRequested':
      return undefined;
    default: {
      const exhaustiveCheck: never = beforeStateResult;
      throw new Error(`[@prisma-audit] Unhandled before-state result: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/** What a single operation (create, update, upsert, delete) left behind once it ran */
export interface SingleOperationOutcome {
  readonly modelName: string;
  readonly action: AuditAction;
  readonly args: Row;
  readonly result: unknown;
  readonly beforeStateResult: BeforeStateResult;
  readonly nestedPreFetchResults: NestedPreFetchResults;
  /** Client the operation ran on; re-fetches the nested rows the result did not include */
  readonly client: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
}

export type EventCollectorDependencies = NestedEventCollectorDependencies;

/**
 * Collect the events of a single operation: the top-level row, then the nested records it wrote
 *
 * An upsert whose before-state fetch failed yields no event at all: a failed fetch cannot tell
 * an absent row from an existing one, so neither the top-level action nor the nested writes of
 * the executed branch can be told (the fetch already reported its failure).
 */
export const collectSingleOperationEvents = async (
  outcome: SingleOperationOutcome,
  deps: EventCollectorDependencies,
): Promise<MutationEvent[]> => {
  const { modelName, action, args, result, beforeStateResult, nestedPreFetchResults, client } = outcome;

  const topLevelUpsertBranch = upsertBranchOf(action, beforeStateResult);
  if (action === AUDIT_ACTION.UPSERT && topLevelUpsertBranch === undefined) {
    return [];
  }

  const before = beforeStateResult._tag === 'found' ? beforeStateResult.data : undefined;
  const row = toRow(result);
  const topLevel: MutationEvent = {
    model: modelName,
    identity: identityOf(row, getPrimaryKeyConstraint(deps.schemaMetadata, modelName)?.fields),
    action: toMutationAction(action, before),
    before,
    after: row,
    origin: { path: '', op: action },
  };

  const nested = await collectNestedEvents(
    { modelName, args, result, client, nestedPreFetchResults, topLevelUpsertBranch },
    deps,
  );

  return [topLevel, ...nested];
};

/** The rows a batch operation (createMany, updateMany, deleteMany and their variants) wrote */
export interface BatchOperationOutcome {
  readonly modelName: string;
  readonly action: AuditAction;
  readonly rows: ReadonlyArray<Row>;
  /** Before state of each row, paired by primary key; absent for createMany */
  readonly beforeStates?: ReadonlyArray<Row | null>;
}

const toSingularAction = (action: AuditAction): MutationAction => {
  const singular = BATCH_TO_SINGULAR_ACTION[action as keyof typeof BATCH_TO_SINGULAR_ACTION];
  if (!singular) {
    throw new Error(`Unknown batch action: ${action}`);
  }
  return singular;
};

/** Collect one event per row of a batch operation, in row order */
export const collectBatchOperationEvents = (
  outcome: BatchOperationOutcome,
  schemaMetadata: SchemaMetadata,
): MutationEvent[] => {
  const { modelName, action, rows, beforeStates } = outcome;
  const singularAction = toSingularAction(action);
  const pkFields = getPrimaryKeyConstraint(schemaMetadata, modelName)?.fields;

  return rows.map((row, index) => ({
    model: modelName,
    identity: identityOf(row, pkFields),
    action: singularAction,
    before: beforeStates?.[index] ?? undefined,
    after: singularAction === 'delete' ? undefined : row,
    origin: { path: '', op: action },
  }));
};
