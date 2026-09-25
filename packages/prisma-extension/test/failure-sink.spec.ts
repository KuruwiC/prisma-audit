/**
 * Tests for the failure sink: a write-failure policy function that throws falls back to 'log'.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFailureSink } from '../src/failure-sink.js';
import type { AuditErrorContext } from '../src/types.js';

const context: AuditErrorContext = {
  phase: 'log-write',
  modelName: 'User',
  operation: 'write',
  params: [],
  error: new Error('insert failed'),
};

describe('createFailureSink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to 'log' when the writeFailurePolicy function throws, so the caller's operation is not failed", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observer = vi.fn(async () => {});
    const sink = createFailureSink({
      observer,
      writeFailurePolicy: async () => {
        throw new Error('policy exploded');
      },
    });

    await expect(sink.reportWriteFailure(context, 'audit log write')).resolves.toBeUndefined();

    expect(observer).toHaveBeenCalledWith(context);
    expect(consoleError).toHaveBeenCalledWith(
      "[@prisma-audit] Error in writeFailurePolicy function; falling back to 'log':",
      'policy exploded',
    );
    expect(consoleError).toHaveBeenCalledWith('[db-audit-core] Error in audit log write:', 'insert failed');
  });
});
