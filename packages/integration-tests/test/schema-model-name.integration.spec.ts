/**
 * Integration Test: the model delegate a client exposes under the model's schema name
 *
 * Prisma exposes each model's delegate under its camelCase accessor (`client.user`) and, untyped,
 * under its schema name (`client.User`), on a client, a client `$extends` derives from it, and a
 * transaction client alike. The audited client wraps both the same way: a write through the
 * schema-named delegate of the audited client or of the client a `$transaction` callback receives
 * is audited, and one through that of a client below the audit, or through the `$parent` of the
 * schema-named delegate of the audited client, is rejected with `AuditParentWriteError`.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectRejectedBelowAudit, parentOf, userData } from './helpers/parent-client.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

type Db = Prisma.TransactionClient;

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'schema-model-name-actor' },
};

/**
 * Where a test issues its calls: on the audited client, or on the client a `$transaction` callback
 * receives
 */
const scopes = [
  ['outside any transaction', false],
  ['inside a transaction', true],
] as const;

/**
 * Types `value` as `delegate`, the camelCase delegate of the same model, checking only that it is an
 * object
 */
const isDelegateLike = <T>(value: unknown, _delegate: T): value is T => typeof value === 'object' && value !== null;

/** The `User` delegate `client` exposes under the schema name, untyped in the generated types */
const schemaNamedUser = <T extends { readonly user: object }>(client: T): T['user'] => {
  const delegate: unknown = Reflect.get(client, 'User');
  if (!isDelegateLike(delegate, client.user)) {
    throw new Error('The client exposes no delegate under the schema name User');
  }
  return delegate;
};

/** The `User` delegates below the audit, read from the client a test issues its calls on */
const usersBelow = [
  ['the schema-named delegate of the $parent', (client: Db) => schemaNamedUser(parentOf(client))],
  ['the $parent of the schema-named delegate', (client: Db) => parentOf(client, schemaNamedUser(client)).user],
] as const;

const usersBelowInScopes = usersBelow.flatMap(([users, usersIn]) =>
  scopes.map(([scope, inTransaction]) => [users, scope, inTransaction, usersIn] as const),
);

describe('the model delegate a client exposes under the schema name', () => {
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();

  beforeEach(async () => {
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  const auditedClient = (mode: 'awaited' | 'atomic') =>
    createAuditClient(basePrisma, {
      ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
      entities: { User: defineEntity({ type: 'User' }) },
      write: { mode },
    });

  const runIn = (
    prisma: ReturnType<typeof auditedClient>,
    inTransaction: boolean,
    body: (client: Db) => Promise<void>,
  ) =>
    provider.runAsync(testActor, async () => {
      await (inTransaction ? prisma.$transaction((tx) => body(tx)) : body(prisma));
    });

  const auditedEmails = async () => {
    await flushAllPendingWrites();
    return (await basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } }))
      .map((log) => (log.after as { email: string }).email)
      .sort();
  };

  describe.each(['awaited', 'atomic'] as const)('under %s', (mode) => {
    it.each(scopes)(
      'audits a write through the schema-named delegate of the audited client, %s',
      async (_scope, inTransaction) => {
        const prisma = auditedClient(mode);

        await runIn(prisma, inTransaction, async (client) => {
          await schemaNamedUser(client).create({ data: userData('client@example.com') });
        });

        expect(await auditedEmails()).toEqual(['client@example.com']);
      },
    );

    it('audits a write through the schema-named delegate of a client $extends derives from the audited client', async () => {
      const prisma = auditedClient(mode);

      await provider.runAsync(testActor, () =>
        schemaNamedUser(prisma.$extends({ name: 'derived' })).create({ data: userData('derived@example.com') }),
      );

      expect(await auditedEmails()).toEqual(['derived@example.com']);
    });

    it.each(usersBelowInScopes)(
      'rejects with AuditParentWriteError a write through %s, %s, and reads through it',
      async (_users, _scope, inTransaction, usersIn) => {
        const prisma = auditedClient(mode);

        await runIn(prisma, inTransaction, async (client) => {
          expect(await usersIn(client).count()).toBe(0);
          await expectRejectedBelowAudit(usersIn(client).create({ data: userData('parent@example.com') }));
        });

        expect(await basePrisma.user.count()).toBe(0);
        expect(await auditedEmails()).toEqual([]);
      },
    );
  });
});
