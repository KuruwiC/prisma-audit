/**
 * Integration Tests: where an awaited audit runs, with and without `openImplicitTransaction`
 *
 * By default the audit extension never opens a transaction: the caller's operation continues
 * through Prisma's `query` down the extension chain once, an awaited audit outside the caller's
 * own interactive `$transaction` is written once the operation has committed, and a batch
 * `$transaction([...])` is Prisma's own. With `openImplicitTransaction` the audited client opens
 * the transaction at its boundary, before the call enters the extension chain: a write whose
 * audit is awaited runs in an interactive transaction of the client it was called on, and a batch
 * of that client's operations runs as one. Either way the caller's mutation passes every query
 * extension once; the audit's own reads and writes are separate queries.
 */

import type { AuditContext, AuditErrorContext, AuditRecord } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'transaction-mode-actor' },
};

interface ClientOptions {
  readonly openImplicitTransaction: boolean;
  readonly awaitWrite?: boolean;
  readonly awaitWriteIf?: (modelName: string) => boolean;
  readonly writer?: (records: AuditRecord[]) => Promise<void>;
  readonly failingEnricher?: boolean;
}

/** One `user.update` pass of a recording extension, and every other User operation it saw */
interface Seen {
  updates: number;
  others: number;
}

const recorder = (name: string, seen: Seen, suffix: string) => ({
  name,
  query: {
    user: {
      async $allOperations({
        operation,
        args,
        query,
      }: {
        operation: string;
        args: Record<string, unknown>;
        query: (args: Record<string, unknown>) => Promise<unknown>;
      }) {
        if (operation !== 'update') {
          seen.others++;
          return query(args);
        }
        seen.updates++;
        const data = args.data as Record<string, unknown>;
        return query({ ...args, data: { ...data, name: `${String(data.name)}${suffix}` } });
      },
    },
  },
});

describe('openImplicitTransaction', () => {
  const databaseUrl = () => inject('databaseUrl');
  const disposers: Array<() => Promise<void>> = [];
  let raw: PrismaClient;

  beforeAll(() => {
    raw = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
    await raw.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(raw);
  });

  /**
   * An audited client between two recording extensions: `before` (applied to the base client, so
   * before the audit extension) appends `!` to an updated name, `after` (applied to the audited
   * client) appends `?`.
   */
  const createClients = (options: ClientOptions) => {
    const base = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    const before: Seen = { updates: 0, others: 0 };
    const after: Seen = { updates: 0, others: 0 };
    const provider = createAsyncLocalStorageProvider();
    const observer = vi.fn<(context: AuditErrorContext) => void>();
    const audited = createAuditClient(base.$extends(recorder('before', before, '!')), {
      Prisma,
      provider,
      aggregateMapping: { User: defineEntity({ type: 'User' }), Post: defineEntity({ type: 'Post' }) },
      performance: {
        awaitWrite: options.awaitWrite ?? true,
        ...(options.awaitWriteIf ? { awaitWriteIf: options.awaitWriteIf } : {}),
        openImplicitTransaction: options.openImplicitTransaction,
      },
      errorHandling: { observer, writeFailurePolicy: 'throw' },
      ...(options.writer ? { hooks: { writer: options.writer } } : {}),
      ...(options.failingEnricher
        ? {
            contextEnricher: {
              actor: {
                enricher: async () => {
                  throw new Error('actor enricher is broken');
                },
              },
            },
          }
        : {}),
    });
    const client = audited.$extends(recorder('after', after, '?'));
    disposers.push(async () => {
      await base.$disconnect();
    });
    const run = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
    return { client, audited, base, before, after, provider, observer, run };
  };

  const seedUser = (email = 'owner@example.com') => raw.user.create({ data: { email, name: 'Before' } });
  const nameOf = async (id: string) => (await raw.user.findUnique({ where: { id } }))?.name;
  const auditRows = async () => {
    await flushAllPendingWrites();
    return (await raw.auditLog.findMany({ select: { entityType: true, action: true } })).map(
      (row) => `${row.entityType}.${row.action}`,
    );
  };
  const failingWriter = async () => {
    throw new Error('audit write failed');
  };

  interface SlowBatchOptions {
    readonly openImplicitTransaction: boolean;
    readonly awaitWrite?: boolean;
    /** The one model whose audit is awaited, through `awaitWriteIf` */
    readonly awaitedModel?: string;
    /** The model the audit records; the batch writes a User */
    readonly audited?: 'User' | 'Post';
    /** Whether the batch writes a User before its slow read */
    readonly writes?: boolean;
  }

  /**
   * A batch whose read takes 500 ms, on an audited client whose interactive transactions time out
   * after 200 ms: it fails with P2028 exactly when it runs as an interactive transaction
   */
  const runSlowBatch = (options: SlowBatchOptions) => {
    const limited = new PrismaClient({
      datasources: { db: { url: databaseUrl() } },
      transactionOptions: { timeout: 200 },
    });
    disposers.push(async () => {
      await limited.$disconnect();
    });
    const provider = createAsyncLocalStorageProvider();
    const audited = createAuditClient(limited, {
      Prisma,
      provider,
      aggregateMapping:
        options.audited === 'Post'
          ? { Post: defineEntity({ type: 'Post' }) }
          : { User: defineEntity({ type: 'User' }) },
      performance: {
        awaitWrite: options.awaitWrite ?? true,
        ...(options.awaitedModel ? { awaitWriteIf: (modelName: string) => modelName === options.awaitedModel } : {}),
        openImplicitTransaction: options.openImplicitTransaction,
      },
    });
    const operations: Prisma.PrismaPromise<unknown>[] = [audited.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.5)`];
    if (options.writes) {
      operations.unshift(audited.user.create({ data: { email: 'slow@example.com', name: 'Slow' } }));
    }
    return provider.runAsync(testActor, () => audited.$transaction(operations));
  };

  describe.each([
    { mode: 'by default', openImplicitTransaction: false },
    { mode: 'with openImplicitTransaction', openImplicitTransaction: true },
  ])('$mode', ({ openImplicitTransaction }) => {
    it('passes the caller update through an extension applied before the audit and one applied after it once each', async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction });

      await clients.run(() => clients.client.user.update({ where: { id: user.id }, data: { name: 'Single' } }));

      expect(await nameOf(user.id)).toBe('Single!?');
      expect(clients.before.updates).toBe(1);
      expect(clients.after.updates).toBe(1);
      // The before-state read is a query of the audit's own, and passes the chain as well.
      expect(clients.before.others).toBeGreaterThan(0);
      expect(await auditRows()).toEqual(['User.update']);
    });

    it('passes each update of a batch through both extensions once', async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction });

      await clients.run(() =>
        clients.client.$transaction([clients.client.user.update({ where: { id: user.id }, data: { name: 'Batch' } })]),
      );

      expect(await nameOf(user.id)).toBe('Batch!?');
      expect(clients.before.updates).toBe(1);
      expect(clients.after.updates).toBe(1);
      expect(await auditRows()).toEqual(['User.update']);
    });

    it('returns the relation of a fluent call', async () => {
      const user = await seedUser();
      await raw.post.create({ data: { title: 'Kept', authorId: user.id } });
      const clients = createClients({ openImplicitTransaction });

      const posts = await clients.run(() =>
        clients.client.user.update({ where: { id: user.id }, data: { name: 'Fluent' } }).posts(),
      );

      expect(posts.map((post) => post.title)).toEqual(['Kept']);
    });

    it('runs every operation of a batch together with an operation the audit does not record and a raw statement', async () => {
      const clients = createClients({ openImplicitTransaction });

      const results = await clients.run(() =>
        clients.client.$transaction([
          clients.client.user.create({ data: { email: 'a@example.com', name: 'A' }, select: { email: true } }),
          clients.client.user.count({ where: { email: 'a@example.com' } }),
          clients.client.$queryRawUnsafe('SELECT $1::int AS v, $2::text AS w', 7, 'x'),
        ]),
      );

      expect(results).toEqual([{ email: 'a@example.com' }, 1, [{ v: 7, w: 'x' }]]);
      expect(await auditRows()).toEqual(['User.create']);
    });

    it('keeps a batch all-or-nothing when one of its writes fails', async () => {
      await seedUser('taken@example.com');
      const clients = createClients({ openImplicitTransaction });

      await expect(
        clients.run(() =>
          clients.client.$transaction([
            clients.client.user.create({ data: { email: 'a@example.com', name: 'A' } }),
            clients.client.user.create({ data: { email: 'taken@example.com', name: 'Duplicate' } }),
          ]),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });

      expect((await raw.user.findMany({ select: { email: true } })).map((row) => row.email)).toEqual([
        'taken@example.com',
      ]);
      expect(await auditRows()).toEqual([]);
    });

    it('runs operations awaited one by one and together', async () => {
      const clients = createClients({ openImplicitTransaction });

      await clients.run(async () => {
        await clients.client.user.create({ data: { email: 'one@example.com', name: 'One' } });
        await Promise.all([
          clients.client.user.create({ data: { email: 'two@example.com', name: 'Two' } }),
          clients.client.user.create({ data: { email: 'three@example.com', name: 'Three' } }),
        ]);
      });

      expect(await raw.user.count()).toBe(3);
      expect(await auditRows()).toEqual(['User.create', 'User.create', 'User.create']);
    });
  });

  describe('by default', () => {
    it('keeps a committed write whose awaited audit write failed, and applies the write-failure policy', async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction: false, writer: failingWriter });

      await expect(
        clients.run(() => clients.client.user.update({ where: { id: user.id }, data: { name: 'Kept' } })),
      ).resolves.toMatchObject({ name: 'Kept!?' });

      expect(await nameOf(user.id)).toBe('Kept!?');
      expect(clients.observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'log-write' }));
    });

    it('keeps a committed write whose awaited audit build failed, and reports the dropped records', async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction: false, failingEnricher: true });

      await expect(
        clients.run(() => clients.client.user.update({ where: { id: user.id }, data: { name: 'Kept' } })),
      ).resolves.toMatchObject({ name: 'Kept!?' });

      expect(await nameOf(user.id)).toBe('Kept!?');
      expect(clients.observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'diff-generation' }));
      expect(await auditRows()).toEqual([]);
    });

    it("commits Prisma's own batch when an operation's audit build fails, and reports the dropped records", async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction: false, failingEnricher: true });

      await clients.run(() =>
        clients.client.$transaction([clients.client.user.update({ where: { id: user.id }, data: { name: 'Kept' } })]),
      );

      expect(await nameOf(user.id)).toBe('Kept!?');
      expect(clients.observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'diff-generation' }));
    });

    it("runs a read-only batch as Prisma's own batch, outside the client's interactive transaction limits", async () => {
      await expect(runSlowBatch({ openImplicitTransaction: false })).resolves.toHaveLength(1);
    });
  });

  describe('with openImplicitTransaction', () => {
    it("runs a read-only batch as Prisma's own batch, outside the client's interactive transaction limits", async () => {
      await expect(runSlowBatch({ openImplicitTransaction: true })).resolves.toHaveLength(1);
    });

    it("runs a batch that writes only a model the audit does not record as Prisma's own batch", async () => {
      await expect(
        runSlowBatch({ openImplicitTransaction: true, audited: 'Post', writes: true }),
      ).resolves.toHaveLength(2);
    });

    it("runs a batch whose write does not await its audit as Prisma's own batch", async () => {
      await expect(
        runSlowBatch({ openImplicitTransaction: true, awaitWrite: false, awaitedModel: 'Post', writes: true }),
      ).resolves.toHaveLength(2);
    });

    it("runs a batch holding a write whose audit is awaited as an interactive transaction, bound by the client's limits", async () => {
      await expect(runSlowBatch({ openImplicitTransaction: true, writes: true })).rejects.toMatchObject({
        code: 'P2028',
      });
      expect(await raw.user.count()).toBe(0);
    });

    it('rolls a write back when its awaited audit write fails', async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction: true, writer: failingWriter });

      await expect(
        clients.run(() => clients.client.user.update({ where: { id: user.id }, data: { name: 'Lost' } })),
      ).rejects.toThrow('audit write failed');

      expect(await nameOf(user.id)).toBe('Before');
    });

    it("rolls back every operation of a batch when one operation's audit build fails", async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction: true, failingEnricher: true });

      await expect(
        clients.run(() =>
          clients.client.$transaction([
            clients.client.user.create({ data: { email: 'a@example.com', name: 'A' } }),
            clients.client.user.update({ where: { id: user.id }, data: { name: 'Lost' } }),
          ]),
        ),
      ).rejects.toThrow('actor enricher is broken');

      expect(await raw.user.count()).toBe(1);
      expect(await nameOf(user.id)).toBe('Before');
    });

    it('runs each client derived from the audited client through its own extensions only', async () => {
      const user = await seedUser();
      const clients = createClients({ openImplicitTransaction: true });
      const first: Seen = { updates: 0, others: 0 };
      const second: Seen = { updates: 0, others: 0 };
      const firstClient = clients.audited.$extends(recorder('first', first, '1'));
      const secondClient = clients.audited.$extends(recorder('second', second, '2'));

      await clients.run(() => firstClient.user.update({ where: { id: user.id }, data: { name: 'First' } }));
      expect(await nameOf(user.id)).toBe('First!1');
      await clients.run(() => secondClient.user.update({ where: { id: user.id }, data: { name: 'Second' } }));
      expect(await nameOf(user.id)).toBe('Second!2');

      expect(first.updates).toBe(1);
      expect(second.updates).toBe(1);
      expect(clients.before.updates).toBe(2);
    });

    it("writes the audit of a batch operation that does not await it once the batch's transaction has committed", async () => {
      const user = await seedUser();
      const clients = createClients({
        openImplicitTransaction: true,
        awaitWrite: false,
        awaitWriteIf: (modelName) => modelName === 'Post',
      });

      await clients.run(() =>
        clients.client.$transaction([
          clients.client.post.create({ data: { title: 'Awaited', authorId: user.id } }),
          clients.client.user.create({ data: { email: 'detached@example.com', name: 'Detached' } }),
        ]),
      );

      expect((await auditRows()).sort()).toEqual(['Post.create', 'User.create']);
    });

    describe('rejects a batch before anything runs', () => {
      it('when an operation was created by a client that is not audited', async () => {
        const clients = createClients({ openImplicitTransaction: true });

        await expect(
          clients.run(() =>
            clients.client.$transaction([
              clients.client.user.create({ data: { email: 'a@example.com', name: 'A' } }),
              raw.user.create({ data: { email: 'b@example.com', name: 'B' } }),
            ]),
          ),
        ).rejects.toThrow('index 1');

        expect(await raw.user.count()).toBe(0);
      });

      it('when an operation was created by another client derived from the audited client', async () => {
        const clients = createClients({ openImplicitTransaction: true });
        const other = clients.audited.$extends({ name: 'other' });

        await expect(
          clients.run(() =>
            clients.client.$transaction([
              clients.client.user.create({ data: { email: 'a@example.com', name: 'A' } }),
              other.user.create({ data: { email: 'b@example.com', name: 'B' } }),
            ]),
          ),
        ).rejects.toThrow('index 1');

        expect(await raw.user.count()).toBe(0);
      });

      it('when an operation has already run', async () => {
        const clients = createClients({ openImplicitTransaction: true });

        await expect(
          clients.run(async () => {
            const created = clients.client.user.create({ data: { email: 'a@example.com', name: 'A' } });
            await created;
            return clients.client.$transaction([
              clients.client.user.create({ data: { email: 'b@example.com', name: 'B' } }),
              created,
            ]);
          }),
        ).rejects.toThrow('index 1');

        expect((await raw.user.findMany({ select: { email: true } })).map((row) => row.email)).toEqual([
          'a@example.com',
        ]);
      });
    });

    it("rejects an operation of the audited client given to another client's batch", async () => {
      const clients = createClients({ openImplicitTransaction: true });

      await expect(
        clients.run(() => raw.$transaction([clients.client.user.create({ data: { email: 'a@example.com' } })])),
      ).rejects.toThrow();

      expect(await raw.user.count()).toBe(0);
    });
  });
});
