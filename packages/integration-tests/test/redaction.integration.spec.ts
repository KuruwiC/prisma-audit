/**
 * Integration Tests: PII Redaction
 *
 * The shared client configures no `redactFields`: the built-in sensitive fields, `password` among
 * them, are masked without it. The tests of the contexts open their own client with `redactFields`.
 */

import type { AuditContext, ValueSerializer } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, UNHANDLED } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createBasePrisma, setupTestContext } from './helpers/setup.js';

describe('PII Redaction Integration: built-in sensitive fields with no redactFields configured', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  it('should redact password field in User creation', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'test@example.com',
          name: 'John Doe',
          password: 'my-secret-password-123',
        },
      });
    });

    const auditLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'create' },
    });

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    const after = log.after as Record<string, unknown>;

    expect(after.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // Other fields should NOT be redacted
    expect(after.email).toBe('test@example.com');
    expect(after.name).toBe('John Doe');
  });

  it('should redact password field in User update', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'test@example.com',
          name: 'John Doe',
          password: 'old-password',
        },
      });
    });

    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.update({
        where: { id: user.id },
        data: { password: 'new-secret-password' },
      });
    });

    const updateLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'update' },
    });

    expect(updateLogs).toHaveLength(1);
    const log = updateLogs[0];

    const before = log.before as Record<string, unknown>;
    const after = log.after as Record<string, unknown>;

    expect(before.password).toEqual({
      redacted: true,
      hadValue: true,
    });
    expect(after.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // Redaction must not hide that the password changed: changes still records it, flagged isDifferent
    expect(log.changes).toBeDefined();
    const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
    expect(changes).toHaveProperty('password');
    expect(changes.password).toEqual({
      old: {
        redacted: true,
        hadValue: true,
      },
      new: {
        redacted: true,
        hadValue: true,
        isDifferent: true,
      },
    });
  });

  it('should redact password field in User deletion', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'delete@example.com',
          name: 'To Delete',
          password: 'sensitive-password',
        },
      });
    });

    const userId = user.id;

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.user.delete({
        where: { id: userId },
      });
    });

    const deleteLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: userId, action: 'delete' },
    });

    expect(deleteLogs).toHaveLength(1);
    const log = deleteLogs[0];

    const before = log.before as Record<string, unknown>;

    expect(before.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    expect(log.after).toBeNull();
  });

  it('should store a null password as null instead of redaction metadata, before and after a change to a value', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: { email: 'no-password@example.com', name: 'No Password' },
      });
    });

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.user.update({
        where: { id: user.id },
        data: { password: 'first-password' },
      });
    });

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.user.update({
        where: { id: user.id },
        data: { password: null },
      });
    });

    const logs: Array<{ action: string; before: unknown; after: unknown; changes: unknown }> =
      await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, aggregateType: 'User' },
      });
    const passwordOf = (state: unknown) => (state as Record<string, unknown>).password;
    const created = logs.find((log) => log.action === 'create');
    const updates = logs.filter((log) => log.action === 'update');
    expect(logs).toHaveLength(3);
    expect(updates).toHaveLength(2);
    const setPassword = updates.find((log) => passwordOf(log.before) === null);
    const clearedPassword = updates.find((log) => passwordOf(log.after) === null);

    expect(passwordOf(created?.after)).toBeNull();

    expect(passwordOf(setPassword?.after)).toEqual({ redacted: true, hadValue: true });
    expect(passwordOf(setPassword?.changes)).toEqual({
      old: null,
      new: { redacted: true, hadValue: true, isDifferent: true },
    });

    expect(passwordOf(clearedPassword?.before)).toEqual({ redacted: true, hadValue: true });
    expect(passwordOf(clearedPassword?.changes)).toEqual({
      old: { redacted: true, hadValue: true },
      new: null,
    });
  });
});

describe('PII Redaction Integration: the enriched contexts and the request context', () => {
  setupTestContext();
  const openedBaseClients: PrismaClient[] = [];

  afterEach(async () => {
    await Promise.all(openedBaseClients.splice(0).map((client) => client.$disconnect()));
  });

  /**
   * An audited client on a fresh Prisma client whose actor, entity, aggregate and request contexts
   * are each `contextOf` their label, under `redactFields: ['nickname']`
   */
  const openClient = (contextOf: (label: string) => unknown, serializers?: readonly ValueSerializer[]) => {
    const basePrisma = createBasePrisma();
    openedBaseClients.push(basePrisma);
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      write: { mode: 'awaited' },
      redactFields: ['nickname'],
      serializers,
      entities: {
        User: defineEntity({
          type: 'User',
          entityContext: { enricher: async (rows) => rows.map(() => contextOf('entity')) },
          selfAggregate: { aggregateContext: { enricher: async (rows) => rows.map(() => contextOf('aggregate')) } },
        }),
      },
      actorContext: { enricher: async () => contextOf('actor') },
    });

    const createUser = (request: Record<string, unknown>) =>
      provider.runAsync({ actor: { category: 'model', type: 'User', id: 'admin-1' }, request }, () =>
        prisma.user.create({ data: { email: 'contexts@example.com', name: 'Contexts' } }),
      );

    const storedContexts = async (userId: string) => {
      const log = await basePrisma.auditLog.findFirstOrThrow({ where: { entityType: 'User', entityId: userId } });
      return {
        actor: log.actorContext,
        entity: log.entityContext,
        aggregate: log.aggregateContext,
        request: log.requestContext,
      };
    };

    return { createUser, storedContexts };
  };

  it('masks the built-in sensitive fields and redactFields at any depth of each context after the serializers ran, keeping the serialized BigInt and Date values', async () => {
    class Device {
      constructor(
        readonly secret: string,
        readonly balance: bigint,
      ) {}
    }
    const contextOf = (label: string) => ({
      label,
      token: `${label}-token`,
      seenAt: new Date('2025-06-01T00:00:00.000Z'),
      session: { apiKey: `${label}-key`, nickname: 'kuro', devices: [new Device(`${label}-secret`, 7n)] },
    });
    const { createUser, storedContexts } = openClient(contextOf);

    const user = await createUser(contextOf('request'));

    const redacted = { redacted: true, hadValue: true };
    const stored = (label: string) => ({
      label,
      token: redacted,
      seenAt: '2025-06-01T00:00:00.000Z',
      session: { apiKey: redacted, nickname: redacted, devices: [{ secret: redacted, balance: '7' }] },
    });
    expect(await storedContexts(user.id)).toEqual({
      actor: stored('actor'),
      entity: stored('entity'),
      aggregate: stored('aggregate'),
      request: stored('request'),
    });
  });

  it('stores in clear the keys inside a context value a serializer turns into a string', async () => {
    class Session {
      constructor(readonly token: string) {}
    }
    const contextOf = (label: string) => ({ token: `${label}-token`, session: new Session(`${label}-session`) });
    const { createUser, storedContexts } = openClient(contextOf, [
      (value) => (value instanceof Session ? JSON.stringify(value) : UNHANDLED),
    ]);

    const user = await createUser(contextOf('request'));

    const stored = (label: string) => ({
      token: { redacted: true, hadValue: true },
      session: `{"token":"${label}-session"}`,
    });
    expect(await storedContexts(user.id)).toEqual({
      actor: stored('actor'),
      entity: stored('entity'),
      aggregate: stored('aggregate'),
      request: stored('request'),
    });
  });
});
