import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import type { PrismaAction } from '../src/types.js';

describe('PrismaAction / AuditAction synchronization', () => {
  it('PrismaAction stays in sync with AuditAction values', () => {
    // Assigning every AUDIT_ACTION value to a PrismaAction[] is the compile-time
    // guard: if the two duplicate definitions drift, this assignment fails to type-check.
    const allActions: PrismaAction[] = Object.values(AUDIT_ACTION);
    expect(allActions).toContain('createManyAndReturn');
    expect(allActions).toContain('updateManyAndReturn');
  });
});
