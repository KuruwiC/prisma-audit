import { vi } from 'vitest';
import { createTransactionAudit } from '../../src/transaction/index.js';

/** The calls of the call-through spy are the audit failures recorded */
export const spiedTransactionAudit = () => {
  const audit = createTransactionAudit();
  const poison = vi.spyOn(audit, 'poison');
  return { audit, poison };
};
