/**
 * Behavioral Tests: Request Context
 *
 * Verifies that AuditContext.request values are stored as requestContext.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import { setupBehavioralTests } from './helpers/setup.js';

describe('Request Context (Behavioral)', () => {
  const { getHarness } = setupBehavioralTests();

  it('should store request context from AuditContext', async () => {
    const h = getHarness();
    const actor: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'req-actor', name: 'Req Actor' },
      request: {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        path: '/api/users',
        method: 'POST',
      },
    };

    const user = await h.runWithContext(actor, () =>
      h.createOne('User', { email: 'request@example.com', name: 'Request', password: 'secret' }),
    );

    const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id as string });
    const log = logs[0];
    if (!log) throw new Error('Expected at least one audit log');
    expect(log.requestContext).toBeDefined();

    const reqCtx = log.requestContext as Record<string, unknown>;
    expect(reqCtx.ipAddress).toBe('192.168.1.1');
    expect(reqCtx.userAgent).toBe('Mozilla/5.0');
    expect(reqCtx.path).toBe('/api/users');
    expect(reqCtx.method).toBe('POST');
  });

  it('should have null requestContext when request is not set', async () => {
    const h = getHarness();
    const actor: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'no-req', name: 'No Req' },
    };

    const user = await h.runWithContext(actor, () =>
      h.createOne('User', { email: 'noreq@example.com', name: 'No Request', password: 'secret' }),
    );

    const logs = await h.readAuditLogs({ entityType: 'User', entityId: user.id as string });
    const log = logs[0];
    if (!log) throw new Error('Expected at least one audit log');
    expect(log.requestContext).toBeNull();
  });
});
