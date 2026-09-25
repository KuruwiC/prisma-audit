import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION,
  type AuditAction,
  BATCH_OPERATIONS,
  BATCH_TO_SINGULAR_ACTION,
  SINGLE_OPERATIONS,
  SUPPORTED_OPERATIONS,
} from '../../src/grammar/operations.js';

describe('operation classification invariants', () => {
  it('SUPPORTED_OPERATIONS contains every AUDIT_ACTION value', () => {
    for (const action of Object.values(AUDIT_ACTION)) {
      expect(SUPPORTED_OPERATIONS.has(action)).toBe(true);
    }
  });

  it('SINGLE_OPERATIONS and BATCH_OPERATIONS partition all AUDIT_ACTION values', () => {
    for (const action of Object.values(AUDIT_ACTION)) {
      const inSingle = SINGLE_OPERATIONS.has(action);
      const inBatch = BATCH_OPERATIONS.has(action);
      expect(inSingle !== inBatch).toBe(true); // XOR
    }
  });

  it('BATCH_TO_SINGULAR_ACTION maps every batch operation to a single action', () => {
    for (const batchAction of BATCH_OPERATIONS) {
      const singular = BATCH_TO_SINGULAR_ACTION[batchAction as keyof typeof BATCH_TO_SINGULAR_ACTION];
      expect(singular).toBeDefined();
      expect(SINGLE_OPERATIONS.has(singular as AuditAction)).toBe(true);
    }
    expect(BATCH_TO_SINGULAR_ACTION.createManyAndReturn).toBe('create');
    expect(BATCH_TO_SINGULAR_ACTION.updateManyAndReturn).toBe('update');
  });
});
