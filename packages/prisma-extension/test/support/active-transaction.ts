import { createTransactionAudit, type TransactionAudit } from '@kuruwic/db-audit-core';
import { vi } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import type { ActiveTransaction } from '../../src/runtime/scope.js';

/** The interactive transaction of `client`, of one level, whose audit `recordedFailuresOf` can read */
export const activeTransactionOf = (
  client: PrismaHandle,
  bind: (transaction: ActiveTransaction) => PrismaHandle = () => client,
): ActiveTransaction => {
  const audit = createTransactionAudit();
  vi.spyOn(audit, 'poison');
  let boundClient: PrismaHandle | undefined;
  const transaction: ActiveTransaction = {
    client,
    get boundClient() {
      boundClient ??= bind(transaction);
      return boundClient;
    },
    audit,
    runOperation: (run) => run(audit),
    noteStatementFailed: () => {},
  };
  return transaction;
};

const spied = <T extends (...args: never[]) => unknown>(method: T) => {
  if (!vi.isMockFunction(method)) {
    throw new Error('expected the audit of a transaction made by activeTransactionOf');
  }
  return method;
};

export const recordedFailuresOf = (audit: TransactionAudit) => spied(audit.poison).mock.calls.map(([error]) => error);
