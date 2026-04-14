/**
 * Behavioral Tests: Actor Context
 *
 * Verifies actor information is correctly stored and enrichment works.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('Actor Context (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  it('should handle system actor category', async () => {
    const h = getHarness();
    const systemActor: AuditContext = {
      actor: { category: 'system', type: 'CronJob', id: 'cron-daily', name: 'Daily Cleanup' },
    };

    const user = await h.runWithContext(systemActor, () =>
      h.createOne('User', { email: 'system@example.com', name: 'System Created', password: 'secret' }),
    );

    const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id as string });
    const log = logs[0];
    if (!log) throw new Error('Expected at least one log');
    expect(log.actorCategory).toBe('system');
    expect(log.actorType).toBe('CronJob');
    expect(log.actorId).toBe('cron-daily');
  });
});
