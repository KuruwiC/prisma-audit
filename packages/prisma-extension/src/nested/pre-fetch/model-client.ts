/**
 * Model delegate shape the pre-fetch fetchers query through.
 *
 * @module nested/pre-fetch/model-client
 */

import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
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
  findMany(args: { where: PreFetchRecord; select?: Record<string, true> }): Promise<PreFetchRecord[]>;
}

/** `modelName` is PascalCase, as in the DMMF. */
export const getPreFetchModelClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
): PreFetchModelClient | undefined => {
  const delegate = getModelDelegate(prismaClient, modelName);
  return hasOperation<PreFetchModelClient>(delegate, 'findUnique') &&
    hasOperation<PreFetchModelClient>(delegate, 'findFirst')
    ? delegate
    : undefined;
};

/** `modelName` is PascalCase, as in the DMMF. */
export const getPreFetchListClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
): PreFetchListClient | undefined => {
  const delegate = getModelDelegate(prismaClient, modelName);
  return hasOperation<PreFetchListClient>(delegate, 'findMany') ? delegate : undefined;
};
