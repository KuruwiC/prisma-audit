/**
 * Behavioral Tests: updateMany / deleteMany
 *
 * Verifies batch update and delete operations produce correct audit logs.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('updateMany / deleteMany (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  const actor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-actor-1', name: 'Test Actor' },
  };

  describe('updateMany', () => {
    it('should create audit logs for each updated record', async () => {
      const h = getHarness();
      // Create test data with unique emails to identify them
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'um1@example.com', name: 'UM1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'um2@example.com', name: 'UM2', password: 'secret' }),
      );
      const user3 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'um3@example.com', name: 'UM3', password: 'secret' }),
      );

      const result = await h.runWithContext(actor, () =>
        h.updateMany('User', { id: { in: [user1.id, user2.id, user3.id] } }, { name: 'Updated' }),
      );

      expect(result.count).toBe(3);

      const updateLogs = await h.readAuditLogs({ entityType: 'User', action: 'update' });
      expect(updateLogs).toHaveLength(3);
    });

    it('should have correct before/after/changes for each updated record', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umba1@example.com', name: 'Before1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umba2@example.com', name: 'Before2', password: 'secret' }),
      );

      await h.runWithContext(actor, () =>
        h.updateMany('User', { id: { in: [user1.id, user2.id] } }, { name: 'After' }),
      );

      const updateLogs = await h.readAuditLogs({ entityType: 'User', action: 'update' });

      for (const log of updateLogs) {
        expect(log.before).not.toBeNull();
        expect(log.after).not.toBeNull();

        const after = log.after as Record<string, unknown>;
        expect(after.name).toBe('After');

        const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
        expect(changes).toHaveProperty('name');
        const nameChange = changes.name;
        expect(nameChange).toBeDefined();
        if (!nameChange) throw new Error('Expected name change to exist');
        expect(nameChange.new).toBe('After');
      }
    });
  });

  describe('deleteMany', () => {
    it('should create audit logs for each deleted record', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'dm1@example.com', name: 'DM1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'dm2@example.com', name: 'DM2', password: 'secret' }),
      );

      const result = await h.runWithContext(actor, () => h.deleteMany('User', { id: { in: [user1.id, user2.id] } }));

      expect(result.count).toBe(2);

      const deleteLogs = await h.readAuditLogs({ entityType: 'User', action: 'delete' });
      expect(deleteLogs).toHaveLength(2);
    });

    it('should have populated before and null after for each deleted record', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'dmba1@example.com', name: 'DelBefore1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'dmba2@example.com', name: 'DelBefore2', password: 'secret' }),
      );

      await h.runWithContext(actor, () => h.deleteMany('User', { id: { in: [user1.id, user2.id] } }));

      const deleteLogs = await h.readAuditLogs({ entityType: 'User', action: 'delete' });
      for (const log of deleteLogs) {
        expect(log.before).not.toBeNull();
        expect(log.after).toBeNull();
      }
    });
  });
});
