/**
 * The omitted fields an entity audits, read after the write
 *
 * An after state taken from the caller's operation result is in the client's default shape, which
 * lacks the fields a client-level `omit` hides. The fields an entity lists in `auditOmittedFields`
 * are read for those rows in one query per model, by row key (`rowKeyFieldsOf`), selecting the key
 * and those fields only, so the caller's query is never widened with them. Rows the audit read
 * itself, through `withOmittedFieldsInFinds`, already hold them, and a deleted row has no after
 * state to store.
 *
 * @module pipeline/omitted-fields-after-write
 */

import type { MutationEvent } from '@kuruwic/db-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import type { SchemaMetadata } from '../schema/types.js';
import type { AuditedOmittedFields } from '../utils/audited-omitted-fields.js';
import { extractEntityIdentity, findManyByPKs, rowKeyFieldsOf } from '../utils/id-generation.js';
import type { EntityIdentityKey } from '../utils/identity-key.js';
import { getModelDelegate, hasOperation } from '../utils/model-accessor.js';

type Row = Record<string, unknown>;

export interface OmittedFieldReadDependencies {
  readonly schemaMetadata: SchemaMetadata;
  readonly auditedOmittedFields: AuditedOmittedFields;
}

interface SelectingFindMany {
  readonly findMany: (args: { where: unknown; select: Record<string, true> }) => Promise<Row[]>;
}

const lacksAny = (event: MutationEvent, fields: ReadonlySet<string>): boolean =>
  event.action !== 'delete' &&
  event.after !== undefined &&
  [...fields].some((field) => !(field in (event.after ?? {})));

const readFields = async (
  handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  keyFields: string[],
  fields: ReadonlySet<string>,
  rows: Row[],
): Promise<Map<EntityIdentityKey, Row>> => {
  const delegate = getModelDelegate(handle, modelName);
  if (!hasOperation<SelectingFindMany>(delegate, 'findMany')) {
    throw new Error(`[@prisma-audit] Cannot read the omitted fields of ${modelName}: no findMany`);
  }
  const select: Record<string, true> = Object.fromEntries([...keyFields, ...fields].map((field) => [field, true]));
  const read = await findManyByPKs({ findMany: ({ where }) => delegate.findMany({ where, select }) }, keyFields, rows);
  return new Map(read.map((row) => [extractEntityIdentity(row, keyFields), row]));
};

const withReadFields = (after: Row, read: Row | undefined, fields: ReadonlySet<string>): Row => {
  if (!read) {
    return after;
  }
  const missing = [...fields].filter((field) => !(field in after) && field in read);
  return missing.length > 0 ? { ...after, ...Object.fromEntries(missing.map((field) => [field, read[field]])) } : after;
};

/**
 * `events` with the after state of each written row completed with the omitted fields its entity
 * audits, in event order; the events themselves when none lacks one
 */
export const readOmittedFieldsAfterWrite = async (
  events: readonly MutationEvent[],
  handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  deps: OmittedFieldReadDependencies,
): Promise<MutationEvent[]> => {
  const lacking = new Map<string, Row[]>();
  for (const event of events) {
    const fields = deps.auditedOmittedFields.of(event.model);
    if (event.after && fields.size > 0 && lacksAny(event, fields)) {
      lacking.set(event.model, [...(lacking.get(event.model) ?? []), event.after]);
    }
  }
  if (lacking.size === 0) {
    return [...events];
  }

  const readByModel = new Map<string, { keyFields: string[]; rows: Map<EntityIdentityKey, Row> }>();
  for (const [modelName, rows] of lacking) {
    const keyFields = rowKeyFieldsOf(deps.schemaMetadata, modelName);
    if (keyFields) {
      const fields = deps.auditedOmittedFields.of(modelName);
      readByModel.set(modelName, { keyFields, rows: await readFields(handle, modelName, keyFields, fields, rows) });
    }
  }

  return events.map((event) => {
    const read = readByModel.get(event.model);
    const fields = deps.auditedOmittedFields.of(event.model);
    if (!read || !event.after || !lacksAny(event, fields)) {
      return event;
    }
    return {
      ...event,
      after: withReadFields(event.after, read.rows.get(extractEntityIdentity(event.after, read.keyFields)), fields),
    };
  });
};
