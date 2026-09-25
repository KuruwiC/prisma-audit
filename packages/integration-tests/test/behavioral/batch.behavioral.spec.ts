/**
 * Behavioral Tests: Batch Operations
 *
 * Verifies that createMany, createManyAndReturn, and updateManyAndReturn produce correct
 * audit logs for each row.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
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

  describe('createManyAndReturn', () => {
    it('should return the created records', async () => {
      const h = getHarness();
      const rows = await h.runWithContext(actor, () =>
        h.createManyAndReturn('User', [
          { email: 'cmr1@example.com', name: 'CMR 1', password: 'secret' },
          { email: 'cmr2@example.com', name: 'CMR 2', password: 'secret' },
        ]),
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.id).toBeTruthy();
    });

    it('should have correct after state for each row', async () => {
      const h = getHarness();
      await h.runWithContext(actor, () =>
        h.createManyAndReturn('User', [
          { email: 'cmrafter1@example.com', name: 'CMR After 1', password: 'secret' },
          { email: 'cmrafter2@example.com', name: 'CMR After 2', password: 'secret' },
        ]),
      );

      const logs = await h.readAuditLogs({ entityType: 'User', action: 'create' });
      const emails = logs.map((l) => (l.after as Record<string, unknown>)?.email).sort();
      expect(emails).toEqual(['cmrafter1@example.com', 'cmrafter2@example.com']);
    });

    it('should have consistent actor info across all logs', async () => {
      const h = getHarness();
      await h.runWithContext(actor, () =>
        h.createManyAndReturn('User', [
          { email: 'cmractor1@example.com', name: 'CMR Actor 1', password: 'secret' },
          { email: 'cmractor2@example.com', name: 'CMR Actor 2', password: 'secret' },
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
        h.createOne('User', { email: 'cmrauthor@example.com', name: 'Author', password: 'secret' }),
      );

      await h.runWithContext(actor, () =>
        h.createManyAndReturn('Post', [
          { title: 'CMR Post 1', content: 'C1', authorId: user.id },
          { title: 'CMR Post 2', content: 'C2', authorId: user.id },
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

  describe('ID format fidelity for @default(uuid(7))', () => {
    const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('createMany injects UUID v7 IDs into rows and audit logs', async () => {
      const h = getHarness();
      await h.runWithContext(actor, () =>
        h.createMany('UuidV7Item', [{ label: 'v7-batch-1' }, { label: 'v7-batch-2' }]),
      );

      const logs = await h.readAuditLogs({ entityType: 'UuidV7Item', action: 'create' });
      expect(logs).toHaveLength(2);
      for (const log of logs) {
        expect(log.entityId).toMatch(UUID_V7_RE);
        expect((log.after as Record<string, unknown>)?.id).toBe(log.entityId);
      }
    });

    it('createManyAndReturn returns rows with UUID v7 IDs matching audit logs', async () => {
      const h = getHarness();
      const rows = await h.runWithContext(actor, () =>
        h.createManyAndReturn('UuidV7Item', [{ label: 'v7-return-1' }, { label: 'v7-return-2' }]),
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.id).toMatch(UUID_V7_RE);
      }

      const logs = await h.readAuditLogs({ entityType: 'UuidV7Item', action: 'create' });
      expect(logs.map((l) => l.entityId).sort()).toEqual(rows.map((r) => r.id as string).sort());
    });
  });

  describe('updateManyAndReturn', () => {
    it('should return the updated records', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umr1@example.com', name: 'Before1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umr2@example.com', name: 'Before2', password: 'secret' }),
      );

      const rows = await h.runWithContext(actor, () =>
        h.updateManyAndReturn('User', { id: { in: [user1.id, user2.id] } }, { name: 'After' }),
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.name).toBe('After');
    });

    it('should have correct before/after/changes for each updated record', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umrba1@example.com', name: 'Before1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umrba2@example.com', name: 'Before2', password: 'secret' }),
      );

      await h.runWithContext(actor, () =>
        h.updateManyAndReturn('User', { id: { in: [user1.id, user2.id] } }, { name: 'After' }),
      );

      const updateLogs = await h.readAuditLogs({ entityType: 'User', action: 'update' });
      expect(updateLogs).toHaveLength(2);

      // Each updated record must be logged exactly once.
      const loggedIds = new Set(updateLogs.map((log) => log.entityId));
      expect(loggedIds).toEqual(new Set([user1.id, user2.id]));

      // Each entity's original name, keyed by id, to correlate the before-state per log.
      const originalNameById: Record<string, string> = {
        [user1.id as string]: 'Before1',
        [user2.id as string]: 'Before2',
      };

      for (const log of updateLogs) {
        expect(log.before).not.toBeNull();
        expect(log.after).not.toBeNull();

        const after = log.after as Record<string, unknown>;
        expect(after.name).toBe('After');

        const expectedOld = originalNameById[log.entityId];
        const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
        expect(changes).toHaveProperty('name');
        expect(changes.name?.new).toBe('After');
        // The before-state must match THIS record's own original name, not just any of the two.
        expect(changes.name?.old).toBe(expectedOld);
        expect((log.before as Record<string, unknown>).name).toBe(expectedOld);
      }
    });

    it('should have consistent actor info across all logs', async () => {
      const h = getHarness();
      const user1 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umractor1@example.com', name: 'Before1', password: 'secret' }),
      );
      const user2 = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'umractor2@example.com', name: 'Before2', password: 'secret' }),
      );

      await h.runWithContext(actor, () =>
        h.updateManyAndReturn('User', { id: { in: [user1.id, user2.id] } }, { name: 'After' }),
      );

      const updateLogs = await h.readAuditLogs({ entityType: 'User', action: 'update' });
      for (const log of updateLogs) {
        expect(log.actorId).toBe('test-actor-1');
        expect(log.actorType).toBe('User');
      }
    });
  });
});
