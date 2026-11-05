import { createTransactionAudit, type TransactionAudit } from '@kuruwic/db-audit-core';
import { vi } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import type { ActiveTransaction } from '../../src/runtime/scope.js';

/** The interactive transaction of `client`, of one level, whose audit `recordedFailuresOf` can read */
export const activeTransactionOf = (client: PrismaHandle): ActiveTransaction => {
  const audit = createTransactionAudit();
  vi.spyOn(audit, 'poison');
  return { client, audit, runOperation: (run) => run(audit), noteStatementFailed: () => {} };
};

const spied = <T extends (...args: never[]) => unknown>(method: T) => {
  if (!vi.isMockFunction(method)) {
    throw new Error('expected the audit of a transaction made by activeTransactionOf');
  }
  return method;
};

export const recordedFailuresOf = (audit: TransactionAudit) => spied(audit.poison).mock.calls.map(([error]) => error);
