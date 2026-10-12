import type { FailureSink } from '@kuruwic/db-audit-core';
import { vi } from 'vitest';

export const stubFailureSink = (): FailureSink => ({
  notify: vi.fn(async () => {}),
  reportResolverFailures: vi.fn(async () => {}),
  reportDroppedBuild: vi.fn(async () => {}),
  reportWriteFailure: vi.fn(async () => {}),
});
