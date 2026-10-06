/**
 * Behavioral Tests: Transaction Atomicity
 *
 * Verifies that audit logs respect transaction boundaries:
 * - commit → logs exist
 * - rollback → logs absent
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('Transaction Atomicity (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  const actor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-actor-1', name: 'Test Actor' },
  };

  it('should create audit logs for multiple operations in a transaction', async () => {
    const h = getHarness();
    await h.runWithContext(actor, () =>
      h.withTransaction(async (tx) => {
        const user = await tx.createOne('User', {
          email: 'multi-tx@example.com',
          name: 'Multi TX',
          password: 'secret',
        });
        await tx.createOne('Post', { title: 'TX Post', content: 'Content', authorId: user.id as string });
      }),
    );

    const userLogs = await h.readAuditLogs({ entityType: 'User', action: 'create' });
    expect(userLogs).toHaveLength(1);

    // One log per aggregate the Post belongs to: its own and its author's.
    const postLogs = await h.readAuditLogs({ entityType: 'Post', action: 'create' });
    expect(postLogs).toHaveLength(2);
    expect(postLogs.map((l) => l.aggregateType).sort()).toEqual(['Post', 'User']);
  });

  it('should reflect latest state in before for tx-internal update', async () => {
    const h = getHarness();
    await h.runWithContext(actor, () =>
      h.withTransaction(async (tx) => {
        const user = await tx.createOne('User', {
          email: 'tx-update@example.com',
          name: 'Before Update',
          password: 'secret',
        });
        await tx.updateOne('User', { id: user.id }, { name: 'After Update' });
      }),
    );

    const updateLogs = await h.readAuditLogs({ entityType: 'User', action: 'update' });
    expect(updateLogs).toHaveLength(1);

    const log = updateLogs[0];
    if (!log) throw new Error('Expected at least one audit log');
    const before = log.before as Record<string, unknown>;
    expect(before.name).toBe('Before Update');
  });

  it('should leave no audit logs and no rows when the transaction rolls back', async () => {
    const h = getHarness();
    const failure = new Error('abort the transaction');

    await expect(
      h.runWithContext(actor, () =>
        h.withTransaction(async (tx) => {
          const user = await tx.createOne('User', {
            email: 'rolled-back@example.com',
            name: 'Rolled Back',
            password: 'secret',
          });
          await tx.createOne('Post', { title: 'Rolled Back Post', content: 'Content', authorId: user.id as string });
          await tx.updateOne('User', { id: user.id }, { name: 'Rolled Back Again' });
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(await h.findMany('User')).toHaveLength(0);
    expect(await h.findMany('Post')).toHaveLength(0);
    expect(await h.countAuditLogs()).toBe(0);
  });
});
