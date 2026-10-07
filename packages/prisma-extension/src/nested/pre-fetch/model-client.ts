/**
 * Model delegate shape the pre-fetch fetchers query through.
 *
 * @module nested/pre-fetch/model-client
 */

import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import { type AuditedOmittedFields, withOmittedFieldsInFinds } from '../../utils/audited-omitted-fields.js';
import { getModelDelegate, hasOperation } from '../../utils/model-accessor.js';

export type PreFetchRecord = Record<string, unknown>;

/**
 * Read methods of a Prisma model delegate. `where` is the model's `WhereUniqueInput` for
 * `findUnique` and a flat field-equality filter for `findFirst`.
 */
export interface PreFetchModelClient {
  findUnique(args: { where: object; select?: Record<string, true> }): Promise<PreFetchRecord | null>;
  findFirst(args: { where: PreFetchRecord; select?: Record<string, true> }): Promise<PreFetchRecord | null>;
}

export interface PreFetchListClient {
  findMany(args: {
    where: PreFetchRecord;
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
  }): Promise<PreFetchRecord[]>;
}

/** `modelName` is the model's name as the schema declares it. */
export const getPreFetchModelClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  auditedOmittedFields: AuditedOmittedFields,
): PreFetchModelClient | undefined => {
  const delegate = getModelDelegate(prismaClient, modelName);
  return hasOperation<PreFetchModelClient>(delegate, 'findUnique') &&
    hasOperation<PreFetchModelClient>(delegate, 'findFirst')
    ? withOmittedFieldsInFinds(delegate, auditedOmittedFields.of(modelName))
    : undefined;
};

/** `modelName` is the model's name as the schema declares it. */
export const getPreFetchListClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  auditedOmittedFields: AuditedOmittedFields,
): PreFetchListClient | undefined => {
  const delegate = getModelDelegate(prismaClient, modelName);
  return hasOperation<PreFetchListClient>(delegate, 'findMany')
    ? withOmittedFieldsInFinds(delegate, auditedOmittedFields.of(modelName))
    : undefined;
};
