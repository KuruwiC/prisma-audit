/**
 * Behavioral test setup using AuditTestHarness.
 *
 * Provides adapter-agnostic test lifecycle management.
 * Swap createPrismaHarness with a Drizzle harness to run the same tests on Drizzle.
 */

import { afterEach, beforeAll, beforeEach } from 'vitest';
import { createTestClients, disposeTestContext, getSharedDatabaseUrl, type TestContext } from '../../helpers/setup.js';
import type { AuditTestHarness } from './harness.js';
import { createPrismaHarness } from './prisma-harness.js';

export type { AuditLogFilter, AuditLogRecord, AuditTestHarness } from './harness.js';

/**
 * Sets up behavioral test lifecycle with isolated harness per test.
 *
 * Usage:
 * ```typescript
 * const { getHarness } = setupBehavioralTests();
 *
 * it('should create audit log', async () => {
 *   const h = getHarness();
 *   const user = await h.runWithContext(actor, () => h.createOne('User', { ... }));
 *   const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id });
 *   expect(logs).toHaveLength(1);
 * });
 * ```
 */
export const setupBehavioralTests = () => {
  let sharedDatabaseUrl: string;
  let testContext: TestContext;
  let harness: AuditTestHarness;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  beforeEach(async () => {
    testContext = createTestClients(sharedDatabaseUrl);

    await testContext.prisma.$connect();
    await testContext.basePrisma.$connect();

    harness = createPrismaHarness(testContext.prisma, testContext.basePrisma, testContext.provider);
    await harness.cleanDatabase();
  });

  afterEach(async () => {
    await disposeTestContext(testContext);
  });

  return {
    getHarness: () => harness,
  };
};
