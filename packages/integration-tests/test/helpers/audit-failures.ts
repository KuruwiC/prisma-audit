import type { AuditFailure, AuditObserver } from '@kuruwic/prisma-audit';
import type { Mock } from 'vitest';

/** Every failure the observer was told about, across all the outcomes it received */
export const failuresOf = (observer: Mock<AuditObserver>): AuditFailure[] =>
  observer.mock.calls.flatMap(([outcome]) => outcome.failures);

/**
 * Every failure the observer was told about as `[phase, modelName, operation]`, or `[phase]` for
 * a failure that concerns no single model's write (`diff-generation`, `log-write`)
 */
export const failureSummariesOf = (observer: Mock<AuditObserver>): string[][] =>
  failuresOf(observer).map((failure) =>
    'modelName' in failure ? [failure.phase, failure.modelName, failure.operation] : [failure.phase],
  );
