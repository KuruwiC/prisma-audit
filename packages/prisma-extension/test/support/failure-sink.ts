import type { FailureSink } from '@kuruwic/db-audit-core';
import { vi } from 'vitest';
import type { OperationFailureSink } from '../../src/pipeline/execution-scope.js';

export const stubFailureSink = (): FailureSink => ({
  notify: vi.fn(async () => {}),
  reportResolverFailures: vi.fn(async () => {}),
  reportDroppedBuild: vi.fn(async () => {}),
  reportWriteFailure: vi.fn(async () => {}),
});

export const stubOperationFailureSink = (): OperationFailureSink => ({
  notify: vi.fn(async () => {}),
  reportResolverFailures: vi.fn(async () => {}),
  reportUnrecordedWrite: vi.fn(),
});
