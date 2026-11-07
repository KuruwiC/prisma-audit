import { vi } from 'vitest';
import type { OperationFailureSink } from '../../src/pipeline/execution-scope.js';

export const stubOperationFailureSink = (): OperationFailureSink => ({
  fail: vi.fn(),
  reportResolveFailure: vi.fn(),
  reportUnrecordedWrite: vi.fn(),
});
