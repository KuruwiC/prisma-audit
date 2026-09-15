/**
 * Model delegate shape the pre-fetch fetchers query through.
 *
 * @module lifecycle/pre-fetch/model-client
 */

import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';

export type PreFetchRecord = Record<string, unknown>;

/**
 * Read methods of a Prisma model delegate. `where` is the model's `WhereUniqueInput` for
 * `findUnique` and a flat field-equality filter for `findFirst`.
 */
export interface PreFetchModelClient {
  findUnique(args: { where: object; select?: Record<string, true> }): Promise<PreFetchRecord | null>;
  findFirst(args: { where: PreFetchRecord }): Promise<PreFetchRecord | null>;
}

const isPreFetchModelClient = (value: unknown): value is PreFetchModelClient =>
  typeof value === 'object' &&
  value !== null &&
  'findUnique' in value &&
  typeof value.findUnique === 'function' &&
  'findFirst' in value &&
  typeof value.findFirst === 'function';

/** `modelName` is PascalCase, as in the DMMF. */
export const getPreFetchModelClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
): PreFetchModelClient | undefined => {
  const delegate = prismaClient[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
  return isPreFetchModelClient(delegate) ? delegate : undefined;
};
