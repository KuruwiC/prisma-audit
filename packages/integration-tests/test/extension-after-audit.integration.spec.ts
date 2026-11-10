/**
 * Integration Tests: query extensions applied after the audit
 *
 * A query extension applied to the audited client (`createAuditClient(prisma).$extends(extension)`)
 * runs between the audit and the database, and may change the values a write writes, as field
 * encryption does. The audit's own queries and the callbacks it runs use the client the operation
 * was issued on, or inside a transaction its transaction client, so they pass through such an
 * extension's hooks too: the before and after states of a record hold the values the application
 * reads.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import {
  createAuditClient,
  defineEntity,
  flushAllPendingWrites,
  type WriteConfig,
  type WriteMode,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'extension-after-audit-actor' },
};

const ENCODED = 'encoded:';
const encode = (value: string) => `${ENCODED}${[...value].reverse().join('')}`;
const decode = (value: string) =>
  value.startsWith(ENCODED) ? [...value.slice(ENCODED.length)].reverse().join('') : value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withName = (data: unknown, transform: (value: string) => string): unknown =>
  isRecord(data) && typeof data.name === 'string' ? { ...data, name: transform(data.name) } : data;

const decodedResult = (result: unknown): unknown =>
  Array.isArray(result) ? result.map((row) => withName(row, decode)) : withName(result, decode);

/** Stores User names encoded and returns them decoded */
const nameEncoding = Prisma.defineExtension({
  name: 'name-encoding',
  query: {
    user: {
      async $allOperations({ args, query }) {
        const encodedArgs = isRecord(args)
          ? {
              ...args,
              ...('data' in args ? { data: withName(args.data, encode) } : {}),
              ...('create' in args ? { create: withName(args.create, encode) } : {}),
              ...('update' in args ? { update: withName(args.update, encode) } : {}),
            }
          : args;
        return decodedResult(await query(encodedArgs as typeof args));
      },
    },
  },
});

describe('query extensions applied after the audit', () => {
  const disposers: Array<() => Promise<void>> = [];
  let raw: PrismaClient;

  beforeAll(() => {
    raw = createBasePrisma();
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

  const createClient = (mode: WriteMode, writer?: WriteConfig['writer']) => {
    const base = createBasePrisma();
    disposers.push(() => base.$disconnect());
    const provider = createAsyncLocalStorageProvider();
    const audited = createAuditClient(base, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: { User: defineEntity({ type: 'User' }), Post: defineEntity({ type: 'Post' }) },
      write: { mode, writer },
    });
    const withContext = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
    return { base, audited, withContext };
  };

  const auditLogsOfUser = (id: string) =>
    raw.auditLog.findMany({
      where: { entityType: 'User', entityId: id },
      select: { action: true, before: true, after: true },
      orderBy: { createdAt: 'asc' },
    });

  describe.each([
    { scope: 'outside any transaction, written once the write has committed', mode: 'awaited', inTransaction: false },
    { scope: 'outside any transaction, written in the background', mode: 'deferred', inTransaction: false },
    { scope: 'in the transaction the client opens for an atomic write', mode: 'atomic', inTransaction: false },
    { scope: 'in an interactive $transaction', mode: 'awaited', inTransaction: true },
  ] as const)('an extension that changes the values a write writes, $scope', ({ mode, inTransaction }) => {
    it('runs the write with the values it writes, and the audit records the values the application reads', async () => {
      const { audited, withContext } = createClient(mode);
      const client = audited.$extends(nameEncoding);
      type Users = Pick<typeof client, 'user'>['user'];
      const run = <T>(fn: (users: Users) => Promise<T>) =>
        withContext(() => (inTransaction ? client.$transaction((tx) => fn(tx.user)) : fn(client.user)));

      const created = await run((users) => users.create({ data: { email: 'encoded@example.com', name: 'Plain' } }));
      const updated = await run((users) => users.update({ where: { id: created.id }, data: { name: 'Changed' } }));

      await flushAllPendingWrites();

      expect(created.name).toBe('Plain');
      expect(updated.name).toBe('Changed');
      expect(await raw.user.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        name: encode('Changed'),
      });
      expect(await auditLogsOfUser(created.id)).toEqual([
        { action: 'create', before: null, after: expect.objectContaining({ name: 'Plain' }) },
        {
          action: 'update',
          before: expect.objectContaining({ name: 'Plain' }),
          after: expect.objectContaining({ name: 'Changed' }),
        },
      ]);
    });
  });

  it.each([{ mode: 'awaited' }, { mode: 'deferred' }] as const)(
    'hands the writer the client a write outside any transaction was issued on, a client derived from the audited client (write mode: $mode)',
    async ({ mode }) => {
      const handles: unknown[] = [];
      const { audited, withContext } = createClient(mode, async (records, { handle, defaultWrite }) => {
        handles.push(handle);
        await defaultWrite(records);
      });
      const client = audited.$extends(nameEncoding);

      await withContext(() => audited.user.create({ data: { email: 'on-audited@example.com', name: 'A' } }));
      await withContext(() => client.user.create({ data: { email: 'on-derived@example.com', name: 'B' } }));
      await flushAllPendingWrites();

      // Compared by identity alone: a failing toBe would print the whole client
      expect(handles.map((handle) => [handle === audited, handle === client])).toEqual([
        [true, false],
        [false, true],
      ]);
    },
  );
});
