/**
 * Behavioral Tests: updateMany / deleteMany
 *
 * Verifies batch update and delete operations produce correct audit logs.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('updateMany / deleteMany (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  const actor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-actor-1', name: 'Test Actor' },
  };

  describe('updateMany', () => {
    it('should have correct before/after/changes for each updated record', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umba1@example.com', name: 'Before1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umba2@example.com', name: 'Before2', password: 'secret' }),
      );

      const result = await h.runWithContext(actor, () =>
        h.updateMany('User', { id: { in: [user1.id, user2.id] } }, { name: 'After' }),
      );
      expect(result.count).toBe(2);

      const updateLogs = await h.readAuditLogs({ entityType: 'User', action: 'update' });
      expect(updateLogs).toHaveLength(2);

      // Each entity's original name, keyed by id, to correlate the before-state per log.
      const originalNameById: Record<string, string> = {
        [user1.id as string]: 'Before1',
        [user2.id as string]: 'Before2',
      };
      expect(new Set(updateLogs.map((log) => log.entityId))).toEqual(new Set([user1.id, user2.id]));

      for (const log of updateLogs) {
        expect(log.before).not.toBeNull();
        expect(log.after).not.toBeNull();

        const before = log.before as Record<string, unknown>;
        expect(before.name).toBe(originalNameById[log.entityId]);

        const after = log.after as Record<string, unknown>;
        expect(after.name).toBe('After');

        const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
        expect(changes.name).toEqual({ old: originalNameById[log.entityId], new: 'After' });
      }
    });
  });

  describe('deleteMany', () => {
    it('should have populated before and null after for each deleted record', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'dmba1@example.com', name: 'DelBefore1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'dmba2@example.com', name: 'DelBefore2', password: 'secret' }),
      );

      const result = await h.runWithContext(actor, () => h.deleteMany('User', { id: { in: [user1.id, user2.id] } }));
      expect(result.count).toBe(2);

      const deleteLogs = await h.readAuditLogs({ entityType: 'User', action: 'delete' });
      expect(deleteLogs).toHaveLength(2);
      expect(new Set(deleteLogs.map((log) => log.entityId))).toEqual(new Set([user1.id, user2.id]));

      const seededNameById: Record<string, string> = {
        [user1.id as string]: 'DelBefore1',
        [user2.id as string]: 'DelBefore2',
      };
      for (const log of deleteLogs) {
        expect(log.before).not.toBeNull();
        expect((log.before as Record<string, unknown>).name).toBe(seededNameById[log.entityId]);
        expect(log.after).toBeNull();
      }
    });
  });
});
