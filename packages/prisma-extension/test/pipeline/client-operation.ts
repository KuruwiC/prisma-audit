import type { AuditContext } from '@kuruwic/db-audit-core';
import { vi } from 'vitest';
import type { PrismaBaseClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { AuditedOperation } from '../../src/pipeline/executor.js';

type Row = Record<string, unknown>;

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };

/** A client of the given model delegates that opens no transaction, as an executor's client never does */
export const clientWith = (delegates: Record<string, Record<string, unknown>>): PrismaBaseClient => ({
  $transaction: async () => {
    throw new Error('no transaction is opened by the executor');
  },
  $extends: () => {
    throw new Error('not used');
  },
  ...delegates,
});

/** The scope of an operation on `client` outside any transaction, its audit awaited */
export const scopeOn = (client: PrismaBaseClient): ExecutionScope => ({
  auditContext,
  handle: client,
  baseClient: client,
  atomic: true,
});

/** The continuation the pipeline would build for `client`: the action of its `user` delegate */
const mutationOn = (client: PrismaBaseClient, action: string): ((args: Row) => Promise<unknown>) => {
  const mutation = (client.user as Record<string, unknown> | undefined)?.[action];
  if (typeof mutation !== 'function') {
    throw new Error(`Model "User" or action "${action}" not found`);
  }
  return mutation as (args: Row) => Promise<unknown>;
};

export const operationOn = (
  client: PrismaBaseClient,
  action: AuditedOperation['action'],
  args: Row,
): AuditedOperation => ({
  model: 'User',
  action,
  args,
  widened: new Map(),
  execute: vi.fn(async (runArgs: Row, runAction: AuditedOperation['action'] = action) =>
    mutationOn(client, runAction)(runArgs),
  ),
});
