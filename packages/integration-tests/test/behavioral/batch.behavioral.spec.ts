/**
 * Behavioral Tests: Batch Operations
 *
 * Verifies that createMany produces correct audit logs for each row.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('Batch Operations (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  const actor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-actor-1', name: 'Test Actor' },
  };

  describe('createMany', () => {
    it('should have correct after state for each row', async () => {
      const h = getHarness();
      await h.runWithContext(actor, () =>
        h.createMany('User', [
          { email: 'after1@example.com', name: 'After 1', password: 'secret' },
          { email: 'after2@example.com', name: 'After 2', password: 'secret' },
        ]),
      );

      const logs = await h.readAuditLogs({ entityType: 'User', action: 'create' });
      const emails = logs.map((l) => (l.after as Record<string, unknown>)?.email).sort();
      expect(emails).toEqual(['after1@example.com', 'after2@example.com']);
    });

    it('should have consistent actor info across all logs', async () => {
      const h = getHarness();
      await h.runWithContext(actor, () =>
        h.createMany('User', [
          { email: 'actor1@example.com', name: 'Actor 1', password: 'secret' },
          { email: 'actor2@example.com', name: 'Actor 2', password: 'secret' },
        ]),
      );

      const logs = await h.readAuditLogs({ entityType: 'User', action: 'create' });
      for (const log of logs) {
        expect(log.actorId).toBe('test-actor-1');
        expect(log.actorType).toBe('User');
      }
    });

    it('should resolve aggregates correctly for batch with FK', async () => {
      const h = getHarness();
      const user = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'batchauthor@example.com', name: 'Author', password: 'secret' }),
      );

      await h.runWithContext(actor, () =>
        h.createMany('Post', [
          { title: 'Batch Post 1', content: 'C1', authorId: user.id },
          { title: 'Batch Post 2', content: 'C2', authorId: user.id },
        ]),
      );

      const postLogs = await h.readAuditLogs({ entityType: 'Post', action: 'create' });
      // Each post should have 2 logs: Post aggregate + User aggregate
      expect(postLogs.length).toBeGreaterThanOrEqual(4);

      const userAggLogs = postLogs.filter((l) => l.aggregateType === 'User');
      expect(userAggLogs.length).toBeGreaterThanOrEqual(2);
      for (const log of userAggLogs) {
        expect(log.aggregateId).toBe(user.id);
      }
    });
  });
});
