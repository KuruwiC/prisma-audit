import { AuditParentWriteError } from '@kuruwic/prisma-audit';
import { expect } from 'vitest';

/**
 * Whether `owner` has a `$parent`, typed as `client`: every Prisma client and model delegate has
 * one, which the generated types leave out
 */
const hasParentLike = <T>(owner: object, _client: T): owner is { readonly $parent: T } => '$parent' in owner;

/**
 * The `$parent` of `owner`, `client` itself or one of its model delegates, typed as `client`: use
 * only the models and methods the levels below `client` have
 */
export const parentOf = <T extends object>(client: T, owner: object = client): T => {
  if (!hasParentLike(owner, client)) {
    throw new Error('The client has no $parent');
  }
  return owner.$parent;
};

export const userData = (email: string) => ({ email, name: email, password: 'secret123' });

/** Asserts that `write` rejects with `AuditParentWriteError` for a `create` on `modelName` */
export const expectRejectedBelowAudit = async (write: PromiseLike<unknown>, modelName = 'User') => {
  await expect(write).rejects.toThrow(AuditParentWriteError);
  await expect(write).rejects.toMatchObject({ modelName, operationModelName: modelName, operation: 'create' });
};
