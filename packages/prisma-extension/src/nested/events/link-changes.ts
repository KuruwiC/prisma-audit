/**
 * Foreign-key changes of related rows
 *
 * The rows a link write may have re-linked (read before the write, see
 * `nested/pre-fetch/link-rows.ts`) are read again after the write, once per path. A row whose
 * foreign key differs between the two reads is audited as an `update` of that row; a row whose
 * foreign key did not change (a `connect` of a row already attached, a `set` keeping a row, a
 * `disconnect` of a row attached elsewhere) yields nothing. When the read before the write failed,
 * a row a write names is read by its unique WHERE and audited with an unavailable before state (a
 * `disconnect` only when it left the row detached); a row detached without being named cannot be
 * told and is not audited.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import type { NestedOperationInfo, NestedPreFetchResults } from '../../grammar/nested-operations.js';
import { namedTargets } from '../../grammar/nested-operations.js';
import { AUDIT_ACTION } from '../../grammar/operations.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import { UNAVAILABLE_BEFORE_STATE } from '../../utils/before-state.js';
import type { ClientOmittedFields } from '../../utils/client-omit.js';
import { matchesUniqueWhere, uniqueWhereAsFilter } from '../../utils/compound-where.js';
import { nestedLog } from '../../utils/debug.js';
import { extractEntityIdentity, primaryKeyOf } from '../../utils/id-generation.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import { attachedFilter, type LinkPathRead, type LinkReads, type LinkWrite } from '../pre-fetch/link-rows.js';
import { getPreFetchListClient } from '../pre-fetch/model-client.js';
import { preFetchedStateNamedBy } from '../pre-fetch/pre-fetch-result-store.js';
import type { CollectedNestedRecord } from './collected-record.js';

type Row = Record<string, unknown>;

/** A row a link write may have re-linked, and how to find it after the write */
interface LinkCandidate {
  readonly write: LinkWrite;
  readonly before: BeforeState;
  /** Its primary key when its before state was read, else the unique WHERE that names it */
  readonly locator: { readonly by: 'primaryKey' | 'uniqueWhere'; readonly where: Row };
  /** The write detaches it: its foreign key holds nothing after the write */
  readonly detached: boolean;
}

const isAttachedTo = (row: Row, read: LinkPathRead, parentKey: Row | undefined): boolean =>
  parentKey !== undefined && matchesUniqueWhere(row, attachedFilter(read.link, parentKey));

const capturedCandidate = (write: LinkWrite, row: Row, read: LinkPathRead, detached: boolean): LinkCandidate => ({
  write,
  before: { kind: 'captured', row },
  locator: { by: 'primaryKey', where: primaryKeyOf(row, read.pkFields) },
  detached,
});

const namedWheresOf = (write: LinkWrite): readonly Row[] =>
  write.operation.operation === 'connectOrCreate'
    ? namedTargets(write.operation.operation, write.operation.data).map((target) => target.where)
    : write.named;

const namedCandidates = (
  write: LinkWrite,
  read: LinkPathRead,
  nestedPreFetchResults: NestedPreFetchResults,
  parentKey: Row | undefined,
): LinkCandidate[] => {
  const { operation } = write;
  if (operation.operation === 'connectOrCreate') {
    return namedWheresOf(write).flatMap((where) => {
      const before = preFetchedStateNamedBy(nestedPreFetchResults, operation.path, where);
      return before.kind === 'captured' && !isAttachedTo(before.row, read, parentKey)
        ? [capturedCandidate(write, before.row, read, false)]
        : [];
    });
  }
  const detachesNamed = operation.operation === 'disconnect';
  if (read.failed) {
    return write.named.map((where) => ({
      write,
      before: UNAVAILABLE_BEFORE_STATE,
      locator: { by: 'uniqueWhere', where },
      detached: detachesNamed,
    }));
  }
  return write.named.flatMap((where) => {
    const row = read.rows.find((candidate) => matchesUniqueWhere(candidate, where));
    return row && (detachesNamed || !isAttachedTo(row, read, parentKey))
      ? [capturedCandidate(write, row, read, detachesNamed)]
      : [];
  });
};

/** The rows linked to the write's parent row before the write that it unlinks without naming them */
const detachedCandidates = (write: LinkWrite, read: LinkPathRead, parentKey: Row | undefined): LinkCandidate[] =>
  write.detaches && parentKey && !read.failed
    ? read.rows
        .filter((row) => isAttachedTo(row, read, parentKey))
        .filter((row) => !namedWheresOf(write).some((where) => matchesUniqueWhere(row, where)))
        .map((row) => capturedCandidate(write, row, read, true))
    : [];

const candidatesOf = (
  write: LinkWrite,
  read: LinkPathRead,
  nestedPreFetchResults: NestedPreFetchResults,
): LinkCandidate[] => {
  const parentKey = read.parentKeys.get(write.operation);
  return [
    ...namedCandidates(write, read, nestedPreFetchResults, parentKey),
    ...detachedCandidates(write, read, parentKey),
  ];
};

/**
 * The candidates at a path, each row read before the write once (the first write that names or
 * detaches it), leaving out rows another nested write audits. A row named without a before state
 * is identified only by the read after the write, which de-duplicates it.
 */
const candidatesAt = (
  read: LinkPathRead,
  nestedPreFetchResults: NestedPreFetchResults,
  audited: ReadonlySet<EntityIdentityKey>,
): LinkCandidate[] => {
  const seen = new Set<EntityIdentityKey>(audited);
  return read.writes.flatMap((write) =>
    candidatesOf(write, read, nestedPreFetchResults).filter((candidate) => {
      if (candidate.before.kind !== 'captured') {
        return true;
      }
      const identity = extractEntityIdentity(candidate.before.row, read.pkFields);
      if (seen.has(identity)) {
        return false;
      }
      seen.add(identity);
      return true;
    }),
  );
};

/**
 * The candidates with a captured before state ahead of the rest, so that of the writes naming one
 * row the one whose before state was read is the one recorded
 */
const capturedFirst = (candidates: readonly LinkCandidate[]): LinkCandidate[] => [
  ...candidates.filter((candidate) => candidate.before.kind === 'captured'),
  ...candidates.filter((candidate) => candidate.before.kind !== 'captured'),
];

const foreignKeyChanged = (before: Row, after: Row, fields: readonly string[]): boolean =>
  fields.some((field) => String(before[field] ?? null) !== String(after[field] ?? null));

const holdsNoParent = (row: Row, fields: readonly string[]): boolean =>
  fields.every((field) => row[field] === null || row[field] === undefined);

/** The record of one candidate; undefined when its link did not change */
const recordOf = (
  candidate: LinkCandidate,
  after: readonly Row[],
  read: LinkPathRead,
): CollectedNestedRecord | undefined => {
  const row = after.find((candidateRow) => matchesUniqueWhere(candidateRow, candidate.locator.where));
  if (!row) {
    return undefined;
  }
  const { fields } = read.link;
  const changed =
    candidate.before.kind === 'captured'
      ? foreignKeyChanged(candidate.before.row, row, fields)
      : !candidate.detached || holdsNoParent(row, fields);
  return changed
    ? { entity: row, action: AUDIT_ACTION.UPDATE, beforeState: candidate.before, relatedModel: read.relatedModel }
    : undefined;
};

export interface LinkChangesInput {
  /** Client the operation ran on */
  readonly client: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  readonly linkReads: LinkReads;
  readonly nestedPreFetchResults: NestedPreFetchResults;
  readonly clientOmittedFields: ClientOmittedFields;
  /** The rows other nested writes audit at a path, whose own record already carries the new foreign key */
  readonly auditedAt: (path: string) => ReadonlySet<EntityIdentityKey>;
  readonly fieldNamesOf: (modelName: string) => ReadonlySet<string>;
}

/**
 * The foreign-key changes each link write made, keyed by write. A failed read rejects: the rows it
 * would have returned cannot be left out of the audit.
 */
export const collectLinkChanges = async (
  input: LinkChangesInput,
): Promise<Map<NestedOperationInfo, CollectedNestedRecord[]>> => {
  const records = new Map<NestedOperationInfo, CollectedNestedRecord[]>();
  for (const [path, read] of input.linkReads) {
    const audited = input.auditedAt(path);
    const candidates = candidatesAt(read, input.nestedPreFetchResults, audited);
    if (candidates.length === 0) {
      continue;
    }
    const client = getPreFetchListClient(input.client, read.relatedModel, input.clientOmittedFields);
    if (!client) {
      throw new Error(`[@prisma-audit] Cannot read the re-linked rows at path "${path}": no model client`);
    }
    const fieldNames = input.fieldNamesOf(read.relatedModel);
    const filters = candidates.map(({ locator }) =>
      locator.by === 'primaryKey' ? locator.where : uniqueWhereAsFilter(locator.where, fieldNames),
    );
    const after = await client.findMany({ where: { OR: filters } });
    nestedLog('re-linked rows read: path=%s rows=%d', path, after.length);
    // Each row once, whichever writes named it, and not a row another nested write audits
    const recorded = new Set(audited);
    for (const candidate of capturedFirst(candidates)) {
      const record = recordOf(candidate, after, read);
      const identity = record ? extractEntityIdentity(record.entity, read.pkFields) : undefined;
      if (!record || identity === undefined || recorded.has(identity)) {
        continue;
      }
      recorded.add(identity);
      const own = records.get(candidate.write.operation) ?? [];
      records.set(candidate.write.operation, own);
      own.push(record);
    }
  }
  return records;
};
