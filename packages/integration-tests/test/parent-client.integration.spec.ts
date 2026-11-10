/**
 * Integration Test: the `$parent` of the audited client and of the clients reachable from it
 *
 * `$parent` is Prisma's: the client one level below, without the extensions applied above that
 * level, inside a transaction that client's transaction client. Outside any transaction it is one
 * client per client below, whichever client or model delegate it is read from. At or above the
 * level the audit was applied to (the levels an extension applied after the audit adds) it is
 * audited as the audited client is. Below it (the client passed to `createAuditClient` and the
 * clients under it) it reads and runs raw SQL, unaudited, but every write through it, of an audited
 * model or not, is rejected with `AuditParentWriteError` before it runs, whatever its arguments
 * and whatever an extension applied before the audit adds to them, as is one through a batch or
 * interactive `$transaction` opened on it, a transaction nested on it, or a client `$extends`
 * derives from it; the rejected write has no outcome. The client passed to `createAuditClient`,
 * which the application holds itself, writes unaudited.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditOutcome, WriteMode } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectRejectedBelowAudit, parentOf, userData } from './helpers/parent-client.js';
import { opensNestedTransactions } from './helpers/prisma-features.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

type Db = Prisma.TransactionClient;

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'parent-client-actor' },
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
 * The `$parent`s a write below the audit is issued through, read from the client a test issues its
 * calls on
 */
const parentsBelow = [
  ['the $parent of the client', (client: Db) => parentOf(client)],
  ['the $parent of its model delegate', (client: Db) => parentOf(client, client.user)],
  ['the $parent of its $parent', (client: Db) => parentOf(parentOf(client))],
] as const;

const parentsBelowInScopes = parentsBelow.flatMap(([parent, parentIn]) =>
  scopes.map(([scope, inTransaction]) => [parent, scope, inTransaction, parentIn] as const),
);

const describeMethodOf = (delegate: object): (() => string) | undefined => {
  const method: unknown = Reflect.get(delegate, 'describe');
  return typeof method === 'function' ? () => String(Reflect.apply(method, delegate, [])) : undefined;
};

describe('the $parent of the audited client and of the clients reachable from it', () => {
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();
  const outcomes: AuditOutcome[] = [];

  beforeEach(async () => {
    outcomes.splice(0);
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  /** Audit options that audit `User` alone, leaving `Post` and `Label` unaudited */
  const auditOptions = (mode: WriteMode) => ({
    ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
    entities: { User: defineEntity({ type: 'User' }) },
    write: { mode },
    observer: async (outcome: AuditOutcome) => {
      outcomes.push(outcome);
    },
  });

  const auditedClient = (mode: WriteMode) => createAuditClient(basePrisma, auditOptions(mode));

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

  const auditRowCount = async () => {
    await flushAllPendingWrites();
    return basePrisma.auditLog.count();
  };

  describe('below the level the audit was applied to', () => {
    describe.each(['awaited', 'atomic'] as const)('under %s', (mode) => {
      it.each(parentsBelowInScopes)(
        'rejects a write through %s with AuditParentWriteError, %s, writing nothing and reporting no outcome',
        async (_parent, _scope, inTransaction, parentIn) => {
          const prisma = auditedClient(mode);

          await runIn(prisma, inTransaction, (client) =>
            expectRejectedBelowAudit(parentIn(client).user.create({ data: userData('parent@example.com') })),
          );

          expect(await basePrisma.user.count()).toBe(0);
          expect(await auditRowCount()).toBe(0);
          expect(outcomes).toEqual([]);
        },
      );

      it('goes on with the transaction of the client a $transaction callback receives once a write through its $parent is rejected', async () => {
        const prisma = auditedClient(mode);

        await runIn(prisma, true, async (tx) => {
          await expectRejectedBelowAudit(parentOf(tx).user.create({ data: userData('parent@example.com') }));
          await tx.user.create({ data: userData('caller@example.com') });
        });

        expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['caller@example.com']);
        expect(await auditedEmails()).toEqual(['caller@example.com']);
      });

      it.each(scopes)(
        'rejects a write of a model that is not audited through the $parent, %s',
        async (_scope, inTransaction) => {
          const prisma = auditedClient(mode);

          await runIn(prisma, inTransaction, (client) =>
            expectRejectedBelowAudit(parentOf(client).label.create({ data: { name: 'below' } }), 'Label'),
          );

          expect(await basePrisma.label.count()).toBe(0);
          expect(outcomes).toEqual([]);
        },
      );

      it('rejects a write of a model that is not audited through the $parent with a nested write of an audited model', async () => {
        const prisma = auditedClient(mode);

        await provider.runAsync(testActor, () =>
          expectRejectedBelowAudit(
            parentOf(prisma).post.create({
              data: { title: 'Nested', author: { create: userData('nested@example.com') } },
            }),
            'Post',
          ),
        );

        expect(await basePrisma.post.count()).toBe(0);
        expect(await basePrisma.user.count()).toBe(0);
        expect(outcomes).toEqual([]);
      });

      it('rejects a write through the $parent to which a query extension applied before the audit adds a nested write of an audited model', async () => {
        const author = await basePrisma.user.create({ data: userData('author@example.com') });
        const prisma = createAuditClient(
          basePrisma.$extends({
            query: {
              post: {
                create: ({ args, query }) =>
                  query({ data: { title: args.data.title, author: { create: userData('added@example.com') } } }),
              },
            },
          }),
          auditOptions(mode),
        );

        await provider.runAsync(testActor, () =>
          expectRejectedBelowAudit(
            parentOf(prisma).post.create({ data: { title: 'Extended', authorId: author.id } }),
            'Post',
          ),
        );

        expect(await basePrisma.post.count()).toBe(0);
        expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['author@example.com']);
        expect(outcomes).toEqual([]);
      });

      const argumentsOf = (authorId: string) => {
        const plain = (): Prisma.PostCreateArgs['data'] => ({ title: 'Plain', authorId });
        const nested = (): Prisma.PostCreateArgs['data'] => ({
          title: 'Nested',
          author: { create: userData('nested@example.com') },
        });
        return [
          [plain, nested],
          [nested, plain],
        ] as const;
      };

      it('rejects a write through the $parent whatever its arguments become before it starts', async () => {
        const author = await basePrisma.user.create({ data: userData('author@example.com') });
        const parent = parentOf(auditedClient(mode));

        await provider.runAsync(testActor, async () => {
          for (const [atCall, atStart] of argumentsOf(author.id)) {
            const args: Prisma.PostCreateArgs = { data: atCall() };
            const created = parent.post.create(args);
            args.data = atStart();
            await expectRejectedBelowAudit(created, 'Post');
          }
        });

        expect(await basePrisma.post.count()).toBe(0);
        expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['author@example.com']);
      });

      it('rejects a batch $transaction on the $parent whatever the arguments of its write become before it starts', async () => {
        const author = await basePrisma.user.create({ data: userData('author@example.com') });
        const parent = parentOf(auditedClient(mode));

        await provider.runAsync(testActor, async () => {
          for (const [atCall, atStart] of argumentsOf(author.id)) {
            const args: Prisma.PostCreateArgs = { data: atCall() };
            const batched = parent.post.create(args);
            args.data = atStart();
            await expectRejectedBelowAudit(parent.$transaction([batched]), 'Post');
          }
        });

        expect(await basePrisma.post.count()).toBe(0);
        expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['author@example.com']);
      });

      it('rejects a batch $transaction on the $parent that holds a write before any of its operations runs, and reports no outcome', async () => {
        const parent = parentOf(auditedClient(mode));

        await provider.runAsync(testActor, async () => {
          await expectRejectedBelowAudit(
            parent.$transaction([parent.user.count(), parent.label.create({ data: { name: 'batched' } })]),
            'Label',
          );
          await expectRejectedBelowAudit(
            parent.$transaction([parent.user.create({ data: userData('batched@example.com') }), parent.user.count()]),
          );
        });

        expect(await basePrisma.label.count()).toBe(0);
        expect(await basePrisma.user.count()).toBe(0);
        expect(outcomes).toEqual([]);
      });

      it('rejects a write through the client an interactive $transaction on the $parent hands its callback, which fails the transaction', async () => {
        const parent = parentOf(auditedClient(mode));

        await provider.runAsync(testActor, () =>
          expectRejectedBelowAudit(
            parent.$transaction(async (tx) => {
              expect(await tx.user.count()).toBe(0);
              await tx.label.create({ data: { name: 'in the transaction' } });
            }),
            'Label',
          ),
        );

        expect(await basePrisma.label.count()).toBe(0);
      });

      it('rejects a write through a client $extends derives from the $parent', async () => {
        const derived = parentOf(auditedClient(mode)).$extends({ name: 'below-the-audit' });

        await provider.runAsync(testActor, async () => {
          await expectRejectedBelowAudit(derived.user.create({ data: userData('derived@example.com') }));
          await expectRejectedBelowAudit(derived.label.create({ data: { name: 'derived' } }), 'Label');
        });

        expect(await basePrisma.user.count()).toBe(0);
        expect(await basePrisma.label.count()).toBe(0);
      });
    });

    describe.runIf(opensNestedTransactions(Prisma.prismaVersion.client))('in a nested transaction', () => {
      it('rejects a write in a transaction nested on the $parent of the client a $transaction callback receives', async () => {
        const prisma = auditedClient('atomic');

        await runIn(prisma, true, async (tx) => {
          await expectRejectedBelowAudit(
            parentOf(tx).$transaction(async (nested) => {
              await nested.user.create({ data: userData('nested-on-parent@example.com') });
            }),
          );
          await tx.user.create({ data: userData('caller@example.com') });
        });

        expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['caller@example.com']);
        expect(await auditedEmails()).toEqual(['caller@example.com']);
      });

      it('rejects a write through the $parent of the client a nested $transaction callback receives', async () => {
        const prisma = auditedClient('atomic');

        await provider.runAsync(testActor, () =>
          prisma.$transaction(async (tx) => {
            await expectRejectedBelowAudit(
              tx.$transaction(async (nested) => {
                await parentOf(nested).label.create({ data: { name: 'nested-parent' } });
              }),
              'Label',
            );
            await tx.user.create({ data: userData('caller@example.com') });
          }),
        );

        expect((await basePrisma.user.findMany()).map((user) => user.email)).toEqual(['caller@example.com']);
        expect(await basePrisma.label.count()).toBe(0);
        expect(await auditedEmails()).toEqual(['caller@example.com']);
      });
    });

    it.each(scopes)('runs reads and raw SQL through the $parent, unaudited, %s', async (_scope, inTransaction) => {
      const prisma = auditedClient('awaited');
      await basePrisma.user.create({ data: userData('existing@example.com') });

      await runIn(prisma, inTransaction, async (client) => {
        expect((await parentOf(client).user.findMany()).map((user) => user.email)).toEqual(['existing@example.com']);
        expect(await parentOf(client).$queryRaw`SELECT 1 AS one`).toEqual([{ one: 1 }]);
      });

      expect(await auditRowCount()).toBe(0);
      expect(outcomes).toEqual([]);
    });

    it('runs reads and raw SQL, unaudited, in a batch and an interactive $transaction opened on the $parent', async () => {
      const parent = parentOf(auditedClient('awaited'));
      await basePrisma.user.create({ data: userData('existing@example.com') });

      await provider.runAsync(testActor, async () => {
        expect(await parent.$transaction([parent.user.count(), parent.$queryRaw`SELECT 1 AS one`])).toEqual([
          1,
          [{ one: 1 }],
        ]);
        await parent.$transaction(async (tx) => {
          expect(await tx.user.count()).toBe(1);
          expect(await tx.$queryRaw`SELECT 1 AS one`).toEqual([{ one: 1 }]);
        });
      });

      expect(await auditRowCount()).toBe(0);
      expect(outcomes).toEqual([]);
    });

    it('is the client one level below without the methods of the extension above it, so a method calling itself on $parent ends below its extension', () => {
      const prisma = createAuditClient(
        basePrisma.$extends({
          model: {
            user: {
              describe(): string {
                const below = describeMethodOf(Prisma.getExtensionContext(this).$parent.user);
                return below ? `extended over ${below()}` : 'base';
              },
            },
          },
        }),
        auditOptions('awaited'),
      );

      expect(prisma.user.describe()).toBe('extended over base');
      expect(describeMethodOf(parentOf(prisma).user)).toBeDefined();
      expect(describeMethodOf(parentOf(parentOf(prisma)).user)).toBeUndefined();
    });
  });

  describe('at or above the level the audit was applied to', () => {
    const extendedClient = () =>
      auditedClient('awaited')
        .$extends({
          model: {
            user: {
              async signUp(email: string) {
                return Prisma.getExtensionContext(this).create({ data: userData(email) });
              },
            },
          },
        })
        .$extends({ model: { user: { greet: () => 'hello' } } });

    it('keeps the methods of the levels between in the $parent of a client an extension applied after the audit adds, and audits their writes', async () => {
      const prisma = extendedClient();
      const parent = parentOf(prisma);

      expect('greet' in prisma.user).toBe(true);
      expect('greet' in parent.user).toBe(false);
      await provider.runAsync(testActor, () => parent.user.signUp('signed-up@example.com'));

      expect(await auditedEmails()).toEqual(['signed-up@example.com']);
    });

    it.each(scopes)(
      'audits a write through the $parent of a client an extension applied after the audit adds, %s',
      async (_scope, inTransaction) => {
        const prisma = extendedClient();

        await provider.runAsync(testActor, async () => {
          await (inTransaction
            ? prisma.$transaction((tx) => parentOf(tx).user.create({ data: userData('parent@example.com') }))
            : parentOf(prisma).user.create({ data: userData('parent@example.com') }));
        });

        expect(await auditedEmails()).toEqual(['parent@example.com']);
      },
    );

    it.each(scopes)(
      'is the client a query extension applied after the audit was applied to, and audits a write through it, %s',
      async (_scope, inTransaction) => {
        const prisma = auditedClient('awaited');
        const derived = prisma.$extends({
          name: 'passing-on',
          query: { $allModels: { $allOperations: ({ args, query }) => query(args) } },
        });

        expect(parentOf(derived)).toBe(prisma);
        expect(parentOf(derived, derived.user)).toBe(prisma);
        await provider.runAsync(testActor, async () => {
          await (inTransaction
            ? derived.$transaction((tx) => parentOf(tx).user.create({ data: userData('parent@example.com') }))
            : parentOf(derived).user.create({ data: userData('parent@example.com') }));
        });

        expect(await auditedEmails()).toEqual(['parent@example.com']);
      },
    );

    it('is, outside any transaction, one client per client below, wherever it is read', () => {
      const prisma = auditedClient('awaited');
      const derived = prisma.$extends({ name: 'derived' });

      expect(parentOf(derived)).toBe(prisma);
      expect(parentOf(derived, derived.user)).toBe(prisma);
      expect(parentOf(prisma, prisma.user)).toBe(parentOf(prisma));
    });

    it('takes the operations of the audited client in a batch $transaction on the $parent of a client derived from it', async () => {
      const prisma = auditedClient('awaited');
      const derived = prisma.$extends({ name: 'derived' });

      await provider.runAsync(testActor, () =>
        parentOf(derived).$transaction([prisma.user.create({ data: userData('batched@example.com') })]),
      );

      expect(await auditedEmails()).toEqual(['batched@example.com']);
    });
  });

  it('runs unaudited a write through the client passed to createAuditClient', async () => {
    auditedClient('awaited');

    await provider.runAsync(testActor, () => basePrisma.user.create({ data: userData('base@example.com') }));

    expect(await basePrisma.user.count()).toBe(1);
    expect(await auditedEmails()).toEqual([]);
  });
});
