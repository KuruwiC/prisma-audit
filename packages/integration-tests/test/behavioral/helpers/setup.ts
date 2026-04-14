/**
 * Behavioral test setup using AuditTestHarness.
 *
 * Provides adapter-agnostic test lifecycle management.
 * Swap createPrismaHarness with a Drizzle harness to run the same tests on Drizzle.
 */

import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import {
  cleanupTestClients,
  createTestClients,
  type SharedTestContext,
  setupTestContainer,
  type TestContext,
  teardownTestContainer,
} from '../../helpers/setup.js';
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
  let sharedContext: SharedTestContext;
  let testContext: TestContext;
  let harness: AuditTestHarness;

  beforeAll(async () => {
    sharedContext = await setupTestContainer();
  }, 60000);

  beforeEach(async () => {
    const clients = createTestClients(sharedContext.databaseUrl);
    testContext = {
      ...clients,
      container: sharedContext.container,
      databaseUrl: sharedContext.databaseUrl,
    };

    await testContext.prisma.$connect();
    await testContext.basePrisma.$connect();

    harness = createPrismaHarness(testContext.prisma, testContext.basePrisma, testContext.provider);
    await harness.cleanDatabase();
  });

  afterEach(async () => {
    await cleanupTestClients(testContext);
  });

  afterAll(async () => {
    await teardownTestContainer(sharedContext);
  });

  return {
    getHarness: () => harness,
  };
};
