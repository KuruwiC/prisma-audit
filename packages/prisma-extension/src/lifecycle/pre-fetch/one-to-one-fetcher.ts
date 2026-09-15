/**
 * One-to-One Relation Pre-fetch Module
 *
 * Captures the before-state of the row a nested to-one `update` / `upsert` / `delete` targets.
 * Such an operation carries no WHERE of its own: its target is the related row whose relation
 * key matches the key of the parent row the operation is nested under.
 *
 * @module lifecycle/pre-fetch/one-to-one-fetcher
 */

import { preFetchLog } from '@kuruwic/prisma-audit-core';
import type { DMMFField, DMMFModel } from '../../internal-types.js';
import type { PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { extractEntityIdOrDefault, type NestedPreFetchResults } from './pre-fetch-result-store.js';

/**
 * How a parent row and its to-one related row reference each other: the related row holds the
 * parent row's `parentFields[i]` value in `relatedFields[i]`, for every field of the key.
 */
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
 * Resolves the link of the to-one relation field `field`, declared on the parent model, from
 * the DMMF.
 *
 * - Owning side (`field` declares `fields` / `references`): the parent row holds
 *   `relationFromFields`, which the related row matches with `relationToFields`.
 * - Inverse side: the related model's field with the same `relationName` is the owning side;
 *   the parent row holds that field's `relationToFields`, which the related row references with
 *   its `relationFromFields`.
 *
 * @throws Error when the DMMF does not describe the owning side of the relation
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
  /** Path of the nested operation (e.g. `profile`, `profile.avatar`) */
  path: string;
  /** Key fields every returned row must carry */
  parentFields: readonly string[];
  /** The top-level operation's `where` */
  topLevelWhere: unknown;
  /** Delegate of the top-level model */
  topLevelModelClient: PreFetchModelClient | undefined;
  /** Before-states pre-fetched so far, shallower paths first */
  preFetchResults: NestedPreFetchResults;
}

/**
 * Returns the rows the nested operation at `path` is nested under.
 *
 * - A direct child of the top-level operation is nested under the top-level row. Its key is read
 *   from the top-level `where` when that names every key field with a plain value; otherwise the
 *   row is fetched with that `where`.
 * - A deeper child is nested under every row pre-fetched at the parent path. Rows recorded as not
 *   existing (`before: null`) have no children.
 *
 * An empty list means there is no parent row to follow: the top-level operation has no `where`,
 * its row does not exist, or nothing exists at the parent path.
 */
export const resolveParentRows = async (input: ResolveParentRowsInput): Promise<PreFetchRecord[]> => {
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
 * Each related row is read with `findFirst` on the flat link key: the link references a unique
 * key of the parent, so at most one related row matches. A parent row whose key is incomplete
 * (a nullable foreign key left unset) references no related row and is not queried.
 *
 * @returns One result per queried parent row; a related row that does not exist yields
 *   `beforeRecord: null`
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
