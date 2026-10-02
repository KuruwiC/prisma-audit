/**
 * One-to-One Relation Pre-fetch Module
 *
 * Captures the before-state of the row a nested to-one `update` / `upsert` / `delete` targets.
 * Such an operation is not addressed by a unique WHERE: its target is the related row whose
 * relation key matches the key of the parent row the operation is nested under.
 *
 * @module nested/pre-fetch/one-to-one-fetcher
 */

import type { ParentRowIdentity } from '../../grammar/nested-state.js';
import type { DMMFField, DMMFModel } from '../../internal-types.js';
import { preFetchLog } from '../../utils/debug.js';
import type { PreFetchModelClient, PreFetchRecord } from './model-client.js';
import { type ResolveParentRowsInput, resolveParentRows } from './parent-rows.js';

/** The related row holds the parent row's `parentFields[i]` value in `relatedFields[i]`. */
export interface ToOneRelationLink {
  readonly parentFields: readonly string[];
  readonly relatedFields: readonly string[];
}

export interface PreFetchOneToOneResult {
  /** The parent row the related row was read under */
  readonly parent: ParentRowIdentity;
  readonly beforeRecord: PreFetchRecord | null;
}

export interface PreFetchOneToOneResults {
  readonly results: PreFetchOneToOneResult[];
  /** False when a parent row could not be read and is not known by its link fields, so its related row was not read */
  readonly parentsKnown: boolean;
}

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

export interface PreFetchOneToOneRelationInput extends Omit<ResolveParentRowsInput, 'parentFields'> {
  link: ToOneRelationLink;
  relatedModelClient: PreFetchModelClient;
  /** The columns to read of each related row; the whole row when absent */
  select?: Record<string, true>;
  /**
   * The unique WHERE of the row a `connect` or `connectOrCreate` links to a parent row ahead of the
   * write read under it, keyed by that parent row; read instead of the row linked to it before the write
   */
  connectedRowWheres?: ReadonlyMap<ParentRowIdentity, PreFetchRecord>;
}

const linkWhereOf = (link: ToOneRelationLink, parentRow: PreFetchRecord): PreFetchRecord | undefined => {
  const values = link.parentFields.map((fieldName) => parentRow[fieldName]);
  if (values.some((value) => value === null || value === undefined)) {
    return undefined;
  }
  return Object.fromEntries(link.relatedFields.map((fieldName, index) => [fieldName, values[index]]));
};

/**
 * Pre-fetches the related row of every parent row the nested to-one operation is nested under.
 *
 * Each related row is read with `findFirst` on the flat link key, which is unique on the related
 * model (the referenced key on the owning side, a unique foreign key on the inverse side), so at
 * most one row matches. A parent row with a null key field (an unset optional foreign key) is
 * skipped, and so is a parent row known only by the primary key its operation's WHERE names when
 * the link fields are other fields of it (a foreign key on the parent row). Under a parent row a
 * `connect` or `connectOrCreate` links a row to ahead of the write, the row it names is read by its
 * unique WHERE.
 *
 * @returns One result per queried parent row, by that row's identity; `beforeRecord` is null when
 *   no related row exists
 */
export const preFetchOneToOneRelation = async (
  input: PreFetchOneToOneRelationInput,
): Promise<PreFetchOneToOneResults> => {
  const { link, relatedModelClient, select, connectedRowWheres } = input;

  const { rows: parentRows, allKnown } = await resolveParentRows({ ...input, parentFields: link.parentFields });
  preFetchLog('1:1 parent rows: path=%s count=%d', input.path, parentRows.length);

  const results: PreFetchOneToOneResult[] = [];
  for (const { identity: parent, row: parentRow } of parentRows) {
    const connectedWhere = connectedRowWheres?.get(parent);
    if (connectedWhere) {
      preFetchLog('1:1 connected row where: %O', connectedWhere);
      const beforeRecord = await relatedModelClient.findUnique(
        select ? { where: connectedWhere, select } : { where: connectedWhere },
      );
      results.push({ parent, beforeRecord });
      continue;
    }

    const relatedWhere = linkWhereOf(link, parentRow);
    if (!relatedWhere) {
      continue;
    }
    preFetchLog('1:1 related where: %O', relatedWhere);

    const beforeRecord = await relatedModelClient.findFirst(
      select ? { where: relatedWhere, select } : { where: relatedWhere },
    );
    results.push({ parent, beforeRecord });
  }

  return { results, parentsKnown: allKnown };
};
