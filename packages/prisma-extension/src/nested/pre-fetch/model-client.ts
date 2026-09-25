/**
 * Model delegate shape the pre-fetch fetchers query through.
 *
 * @module nested/pre-fetch/model-client
 */

import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import { getModelDelegate } from '../../utils/model-accessor.js';

export type PreFetchRecord = Record<string, unknown>;

/**
 * Read methods of a Prisma model delegate. `where` is the model's `WhereUniqueInput` for
 * `findUnique` and a flat field-equality filter for `findFirst`.
 */
export interface PreFetchModelClient {
  findUnique(args: { where: object; select?: Record<string, true> }): Promise<PreFetchRecord | null>;
  findFirst(args: { where: PreFetchRecord }): Promise<PreFetchRecord | null>;
}

/** Read method of a Prisma model delegate that returns every row a filter matches */
export interface PreFetchListClient {
  findMany(args: { where: PreFetchRecord; select?: Record<string, true> }): Promise<PreFetchRecord[]>;
}

const isPreFetchModelClient = (value: unknown): value is PreFetchModelClient =>
  typeof value === 'object' &&
  value !== null &&
  'findUnique' in value &&
  typeof value.findUnique === 'function' &&
  'findFirst' in value &&
  typeof value.findFirst === 'function';

const isPreFetchListClient = (value: unknown): value is PreFetchListClient =>
  typeof value === 'object' && value !== null && 'findMany' in value && typeof value.findMany === 'function';

/** `modelName` is PascalCase, as in the DMMF. */
export const getPreFetchModelClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
): PreFetchModelClient | undefined => {
  const delegate = getModelDelegate(prismaClient, modelName);
  return isPreFetchModelClient(delegate) ? delegate : undefined;
};

/** `modelName` is PascalCase, as in the DMMF. */
export const getPreFetchListClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
): PreFetchListClient | undefined => {
  const delegate = getModelDelegate(prismaClient, modelName);
  return isPreFetchListClient(delegate) ? delegate : undefined;
};
