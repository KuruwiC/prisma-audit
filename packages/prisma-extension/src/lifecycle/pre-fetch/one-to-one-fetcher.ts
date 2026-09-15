/**
 * One-to-One Relation Pre-fetch Module
 *
 * Captures the before-state of the row a nested to-one `update` / `upsert` / `delete` targets.
 * Such an operation is not addressed by a unique WHERE: its target is the related row whose
 * relation key matches the key of the parent row the operation is nested under.
 *
 * @module lifecycle/pre-fetch/one-to-one-fetcher
 */

import { type NestedPreFetchResults, preFetchLog } from '@kuruwic/prisma-audit-core';
import type { DMMFField, DMMFModel } from '../../internal-types.js';
import type { PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { extractEntityIdOrDefault } from './pre-fetch-result-store.js';

/** The related row holds the parent row's `parentFields[i]` value in `relatedFields[i]`. */
export interface ToOneRelationLink {
  readonly parentFields: readonly string[];
  readonly relatedFields: readonly string[];
}

export interface PreFetchOneToOneResult {
  entityId: string;
  beforeRecord: PreFetchRecord | null;
}

const isRecord = (value: unknown): value is PreFetchRecord => typeof value === 'object' && value !== null;

const isKeyValue = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';

const pairLinkFields = (
  relationName: string,
  parentFields: readonly string[] | undefined,
  relatedFields: readonly string[] | undefined,
): ToOneRelationLink => {
  if (!parentFields || !relatedFields || parentFields.length === 0 || parentFields.length !== relatedFields.length) {
    throw new Error(
      `[@prisma-audit] Relation "${relationName}" pairs key fields [${parentFields?.join(', ') ?? ''}] ` +
        `with [${relatedFields?.join(', ') ?? ''}]; expected two non-empty lists of the same length`,
    );
  }
  return { parentFields, relatedFields };
};

/**
 * Resolves the link of `field`, a to-one relation field declared on the parent model.
 *
 * - Owning side (`field` declares `fields` / `references`): the parent row holds
 *   `relationFromFields`, which the related row matches with `relationToFields`.
 * - Inverse side: the related model's field with the same `relationName` is the owning side;
 *   the parent row holds that field's `relationToFields`, which the related row references with
 *   its `relationFromFields`.
 *
 * @throws Error when the DMMF gives no relation name, no owning side, or key-field lists that do
 *   not pair up
 */
export const resolveToOneRelationLink = (field: DMMFField, relatedModel: DMMFModel | undefined): ToOneRelationLink => {
  const { relationName } = field;
  if (!relationName) {
    throw new Error(`[@prisma-audit] Relation field "${field.name}" has no relation name in the DMMF`);
  }

  if (field.relationFromFields && field.relationFromFields.length > 0) {
    return pairLinkFields(relationName, field.relationFromFields, field.relationToFields);
  }

  const owningField = relatedModel?.fields.find(
    (candidate) => candidate.relationName === relationName && (candidate.relationFromFields?.length ?? 0) > 0,
  );
  if (!owningField) {
    throw new Error(`[@prisma-audit] Relation "${relationName}" has no owning side on model "${field.type}"`);
  }

  return pairLinkFields(relationName, owningField.relationToFields, owningField.relationFromFields);
};

export interface ResolveParentRowsInput {
  path: string;
  parentFields: readonly string[];
  topLevelWhere: unknown;
  topLevelModelClient: PreFetchModelClient | undefined;
  /** Read for the parent path's rows, so operations must be pre-fetched shallowest path first */
  preFetchResults: NestedPreFetchResults;
}

/**
 * Returns the rows the nested operation at `path` is nested under: for a deeper path, every row
 * that exists at the parent path; for a direct child, the top-level row, keyed from `where`
 * without a query when `where` names every key field with a plain value.
 */
const resolveParentRows = async (input: ResolveParentRowsInput): Promise<PreFetchRecord[]> => {
  const { path, parentFields, topLevelWhere, topLevelModelClient, preFetchResults } = input;

  const separatorIndex = path.lastIndexOf('.');
  if (separatorIndex !== -1) {
    const parentPath = path.slice(0, separatorIndex);
    const parentEntries = preFetchResults.get(parentPath)?.values() ?? [];
    return Array.from(parentEntries, (entry) => entry.before).filter(isRecord);
  }

  if (!isRecord(topLevelWhere)) {
    return [];
  }

  if (parentFields.every((fieldName) => isKeyValue(topLevelWhere[fieldName]))) {
    return [Object.fromEntries(parentFields.map((fieldName) => [fieldName, topLevelWhere[fieldName]]))];
  }

  if (!topLevelModelClient) {
    throw new Error(`[@prisma-audit] No model client to read the parent key of nested path "${path}"`);
  }

  const select: Record<string, true> = Object.fromEntries(parentFields.map((fieldName) => [fieldName, true]));
  const parentRow = await topLevelModelClient.findUnique({ where: topLevelWhere, select });
  preFetchLog('1:1 fetched top-level parent key: path=%s found=%s', path, parentRow !== null);
  return parentRow ? [parentRow] : [];
};

export interface PreFetchOneToOneRelationInput extends Omit<ResolveParentRowsInput, 'parentFields'> {
  link: ToOneRelationLink;
  relatedModelClient: PreFetchModelClient;
  pkFields?: string[];
}

/**
 * Pre-fetches the related row of every parent row the nested to-one operation is nested under.
 *
 * Each related row is read with `findFirst` on the flat link key, which is unique on the related
 * model (the referenced key on the owning side, a unique foreign key on the inverse side), so at
 * most one row matches. A parent row with a null key field (an unset optional foreign key) is
 * skipped.
 *
 * @returns One result per queried parent row; `beforeRecord` is null when no related row exists
 */
export const preFetchOneToOneRelation = async (
  input: PreFetchOneToOneRelationInput,
): Promise<PreFetchOneToOneResult[]> => {
  const { link, relatedModelClient, pkFields } = input;

  const parentRows = await resolveParentRows({ ...input, parentFields: link.parentFields });
  preFetchLog('1:1 parent rows: path=%s count=%d', input.path, parentRows.length);

  const results: PreFetchOneToOneResult[] = [];
  for (const parentRow of parentRows) {
    const values = link.parentFields.map((fieldName) => parentRow[fieldName]);
    if (values.some((value) => value === null || value === undefined)) {
      continue;
    }

    const relatedWhere = Object.fromEntries(link.relatedFields.map((fieldName, index) => [fieldName, values[index]]));
    preFetchLog('1:1 related where: %O', relatedWhere);

    const beforeRecord = await relatedModelClient.findFirst({ where: relatedWhere });
    results.push({ entityId: extractEntityIdOrDefault(beforeRecord, pkFields), beforeRecord });
  }

  return results;
};
