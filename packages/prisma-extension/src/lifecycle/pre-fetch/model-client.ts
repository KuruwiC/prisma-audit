/**
 * Model delegate shape the pre-fetch fetchers query through.
 *
 * @module lifecycle/pre-fetch/model-client
 */

import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';

export type PreFetchRecord = Record<string, unknown>;

/**
 * The read methods of a Prisma model delegate used to capture before-states. `where` is the
 * model's `WhereUniqueInput` for `findUnique` and a flat field-equality filter for `findFirst`.
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

/**
 * Returns the delegate of `modelName` (PascalCase) on `prismaClient`, or `undefined` when the
 * client exposes no such delegate.
 */
export const getPreFetchModelClient = (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
): PreFetchModelClient | undefined => {
  const delegate = prismaClient[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
  return isPreFetchModelClient(delegate) ? delegate : undefined;
};
