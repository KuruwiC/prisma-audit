/**
 * Date Hydration Module
 *
 * Re-fetches operation results to ensure proper Date object hydration. Prisma's query()
 * returns JSON-serialized results where Date objects become empty objects ({}), requiring
 * database re-fetch for actual Date instances.
 *
 * @module lifecycle/operation-handlers/date-hydration
 */

import { AUDIT_ACTION, coreLog } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../internal-types.js';
import type { OperationContext } from '../../types.js';

/**
 * Re-fetch operation result to ensure proper Date hydration
 *
 * Only applies to create/update/upsert operations. Uses ID from result (create) or where clause
 * from args (update/upsert). Preserves include/select for enrichment.
 *
 * @param result - Original query result (may have Date serialization issues)
 * @param operation - Operation context (model, action, args)
 * @param clientToUse - Prisma client for database access
 * @returns Re-fetched result with proper Date objects, or original result if re-fetch fails
 *
 * @internal
 * @see {@link https://github.com/prisma/prisma/issues/12786}
 */
export const refetchForDateHydration = async (
  result: unknown,
  operation: OperationContext,
  clientToUse: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
): Promise<unknown> => {
  if (
    operation.action !== AUDIT_ACTION.CREATE &&
    operation.action !== AUDIT_ACTION.UPDATE &&
    operation.action !== AUDIT_ACTION.UPSERT
  ) {
    return result;
  }

  try {
    const modelDelegate = clientToUse[operation.model as string] as {
      findUnique?: (args: { where: Record<string, unknown>; include?: unknown; select?: unknown }) => Promise<unknown>;
    };

    if (!modelDelegate?.findUnique) {
      return result;
    }

    let whereClause: Record<string, unknown> | null = null;

    if (operation.action === AUDIT_ACTION.CREATE) {
      const resultRecord = result as Record<string, unknown>;
      if (resultRecord.id !== undefined) {
        whereClause = { id: resultRecord.id };
      }
    } else if (operation.action === AUDIT_ACTION.UPDATE || operation.action === AUDIT_ACTION.UPSERT) {
      const args = operation.args as { where?: Record<string, unknown> };
      if (args.where) {
        whereClause = args.where;
      }
    }

    if (!whereClause) {
      return result;
    }

    const args = operation.args as { include?: unknown; select?: unknown };
    const findArgs: { where: Record<string, unknown>; include?: unknown; select?: unknown } = {
      where: whereClause,
    };
    if (args.include) {
      findArgs.include = args.include;
    }
    if (args.select) {
      findArgs.select = args.select;
    }

    const refetchedResult = await modelDelegate.findUnique(findArgs);
    if (refetchedResult) {
      return refetchedResult;
    }

    return result;
  } catch (error) {
    coreLog('Failed to re-fetch result for Date hydration: %O', error);
    return result;
  }
};
