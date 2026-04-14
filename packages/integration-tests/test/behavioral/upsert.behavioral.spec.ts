/**
 * Behavioral Tests: Upsert Operations
 *
 * Verifies that upsert produces correct audit logs for both create and update paths.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('Upsert Operations (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  const actor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-actor-1', name: 'Test Actor' },
  };

  describe('Create path (record does not exist)', () => {
    it('should create audit log with action=create when record is new', async () => {
      const h = getHarness();
      const user = await h.runWithContext(actor, () =>
        h.upsertOne(
          'User',
          { email: 'upsert-new@example.com' },
          { email: 'upsert-new@example.com', name: 'Upsert New', password: 'secret' },
          { name: 'Should Not Apply' },
        ),
      );

      expect(user.name).toBe('Upsert New');

      const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id as string });
      expect(logs.length).toBeGreaterThanOrEqual(1);

      const createLog = logs.find((l) => l.action === 'create');
      expect(createLog).toBeDefined();
      expect(createLog?.before).toBeNull();
      expect(createLog?.after).not.toBeNull();
    });
  });

  describe('Update path (record exists)', () => {
    it('should create audit log with action=update when record exists', async () => {
      const h = getHarness();
      // Create initial record
      await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'upsert-existing@example.com', name: 'Original', password: 'secret' }),
      );

      // Upsert same record
      const user = await h.runWithContext(actor, () =>
        h.upsertOne(
          'User',
          { email: 'upsert-existing@example.com' },
          { email: 'upsert-existing@example.com', name: 'Should Not Apply', password: 'secret' },
          { name: 'Upsert Updated' },
        ),
      );

      expect(user.name).toBe('Upsert Updated');

      const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id as string, action: 'update' });
      expect(logs.length).toBeGreaterThanOrEqual(1);

      const updateLog = logs[0];
      if (!updateLog) throw new Error('Expected at least one audit log');
      expect(updateLog.before).not.toBeNull();
      expect(updateLog.after).not.toBeNull();

      const before = updateLog.before as Record<string, unknown>;
      const after = updateLog.after as Record<string, unknown>;
      expect(before.name).toBe('Original');
      expect(after.name).toBe('Upsert Updated');
    });

    it('should include changes for update path', async () => {
      const h = getHarness();
      await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'upsert-changes@example.com', name: 'Before', password: 'secret' }),
      );

      const user = await h.runWithContext(actor, () =>
        h.upsertOne(
          'User',
          { email: 'upsert-changes@example.com' },
          { email: 'upsert-changes@example.com', name: 'Not Applied', password: 'secret' },
          { name: 'After' },
        ),
      );

      const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id as string, action: 'update' });
      const log = logs[0];
      if (!log) throw new Error('Expected at least one audit log');
      const changes = log.changes as Record<string, { old: unknown; new: unknown }>;

      expect(changes).toHaveProperty('name');
      expect(changes.name).toEqual({ old: 'Before', new: 'After' });
    });
  });

  describe('Aggregate resolution', () => {
    it('should resolve aggregates correctly for upsert', async () => {
      const h = getHarness();
      const user = await h.runWithContext(actor, () =>
        h.createOne('User', { email: 'upsert-agg@example.com', name: 'Author', password: 'secret' }),
      );

      const post = await h.runWithContext(actor, () =>
        h.upsertOne(
          'Post',
          { id: 'nonexistent-post-id' },
          { title: 'New Post', content: 'Content', authorId: user.id as string },
          { title: 'Updated' },
        ),
      );

      const logs = await h.readAuditLogs({ entityType: 'Post', entityId: post.id as string });
      const aggregateTypes = logs.map((l) => l.aggregateType).sort();
      expect(aggregateTypes).toContain('Post');
      expect(aggregateTypes).toContain('User');
    });
  });
});
