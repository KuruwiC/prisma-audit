/**
 * Integration Tests: writes a user callback issues while the audit processes an operation
 *
 * A write of an audited model that a callback the audit runs (an id resolver, an enricher, the
 * `onError` of an enricher whose lookup failed, the writer, the observer) issues, through the
 * client it receives or the audited client, is rejected with `AuditReentrantWriteError` before it
 * runs; a write through the `$parent` of either, which lies below the audit, is rejected with
 * `AuditParentWriteError`, of an audited model or not. Either way its row is not written, it has
 * no outcome, and an enricher's `onError` cannot turn it into a fallback. The operation it was
 * issued for fails or reports the failure by the rules of the place it was rejected in. A write of
 * a model that is not audited through the client a callback receives runs, and so does a write
 * through the client passed to `createAuditClient`, unaudited.
 */

import type { ErrorStrategy } from '@kuruwic/db-audit-core';
import type {
  AuditContext,
  AuditFailurePhase,
  AuditLogWriter,
  AuditObserver,
  AuditOutcome,
  EntityMap,
  WriteMode,
} from '@kuruwic/prisma-audit';
import {
  AuditIncompleteError,
  AuditParentWriteError,
  AuditReentrantWriteError,
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineEntity,
  flushAllPendingWrites,
} from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parentOf } from './helpers/parent-client.js';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

type Db = Prisma.TransactionClient;
type UserRow = { id: string; email: string };

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'reentrant-write-actor' },
};

/**
 * `transactional` holds where the audit runs in one transaction with the write, which a failure of
 * the audit fails: the implicit one of an atomic write, or an explicit one
 */
const scopes = [
  { scope: 'outside any transaction, atomic', mode: 'atomic', inTransaction: false, transactional: true },
  { scope: 'outside any transaction, awaited', mode: 'awaited', inTransaction: false, transactional: false },
  { scope: 'outside any transaction, deferred', mode: 'deferred', inTransaction: false, transactional: false },
  { scope: 'inside a transaction, atomic', mode: 'atomic', inTransaction: true, transactional: true },
  { scope: 'inside a transaction, awaited', mode: 'awaited', inTransaction: true, transactional: true },
  { scope: 'inside a transaction, deferred', mode: 'deferred', inTransaction: true, transactional: true },
] as const satisfies ReadonlyArray<{ scope: string; mode: WriteMode; inTransaction: boolean; transactional: boolean }>;

interface Callbacks {
  readonly user?: EntityMap<'User', Db>['User'];
  readonly writer?: AuditLogWriter<Db>;
  readonly observer?: AuditObserver;
}

/**
 * The callbacks of a test, given `write`, the write they make on a client; `audited`, the audited
 * client, for a callback that receives no client; and `base`, the client passed to
 * `createAuditClient`
 */
type CallbacksOf = (write: (db: Db) => Promise<void>, audited: () => Db, base: () => PrismaClient) => Callbacks;

const userEnrichedBy = (write: (db: Db) => Promise<void>, { onError }: { readonly onError?: ErrorStrategy } = {}) =>
  defineEntity<UserRow, Db>({
    type: 'User',
    entityContext: {
      enricher: async (rows, db) => {
        await write(db);
        return rows.map(() => null);
      },
      ...(onError ? { onError } : {}),
    },
  });

describe('a write a user callback issues while the audit processes an operation', () => {
  let basePrisma: PrismaClient;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(() => {
    basePrisma = createBasePrisma();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  /** An audited client that audits `User` and `Tag` alone, leaving `Label` and `Post` unaudited */
  const createClient = (mode: WriteMode, write: (db: Db) => Promise<void>, callbacksOf: CallbacksOf) => {
    const base = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const outcomes: AuditOutcome[] = [];
    const { user, writer, observer } = callbacksOf(
      write,
      () => prisma,
      () => base,
    );
    const prisma = createAuditClient(base, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: { User: user ?? defineEntity({ type: 'User' }), Tag: defineEntity({ type: 'Tag' }) },
      write: { mode, ...(writer ? { writer } : {}) },
      observer:
        observer ??
        (async (outcome) => {
          outcomes.push(outcome);
        }),
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await base.$disconnect();
    });
    const createUser = (inTransaction: boolean) => {
      const data = { email: 'caller@example.com' };
      return provider.runAsync(testActor, async () => {
        await (inTransaction ? prisma.$transaction((tx) => tx.user.create({ data })) : prisma.user.create({ data }));
      });
    };
    return { createUser, outcomes };
  };

  const keepingRejection = async (rejections: unknown[], write: () => Promise<unknown>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      rejections.push(error);
      throw error;
    }
  };

  const tagWrite =
    (rejections: unknown[]) =>
    (db: Db): Promise<void> =>
      keepingRejection(rejections, () => db.tag.create({ data: { name: 'written by a callback' } }));

  type Rejection = typeof AuditReentrantWriteError | typeof AuditParentWriteError;

  const expectRejectedTagWrite = async (rejections: readonly unknown[], rejectedWith: Rejection) => {
    expect(rejections).toEqual([expect.any(rejectedWith)]);
    expect(rejections[0]).toMatchObject({ modelName: 'Tag', operationModelName: 'Tag', operation: 'create' });
    expect(await basePrisma.tag.count()).toBe(0);
    expect(await basePrisma.auditLog.count({ where: { entityType: 'Tag' } })).toBe(0);
  };

  const callbackKinds: ReadonlyArray<{
    readonly kind: string;
    readonly phase: AuditFailurePhase;
    /**
     * Whether the rejection fails an operation that is not atomic inside a transaction; it fails an
     * atomic one wherever it runs
     */
    readonly failsInTransaction: boolean;
    /**
     * Whether an atomic operation fails with the `AuditIncompleteError` of the record the rejection
     * dropped, which lists it among its failures, rather than with the rejection itself
     */
    readonly incompleteWhenAtomic: boolean;
    readonly rejectedWith: Rejection;
    readonly callbacksOf: CallbacksOf;
  }> = [
    {
      kind: 'an idResolver, through the client it receives',
      phase: 'id-resolver-call',
      failsInTransaction: false,
      incompleteWhenAtomic: true,
      rejectedWith: AuditReentrantWriteError,
      callbacksOf: (write) => ({
        user: defineEntity<UserRow, Db>({
          type: 'User',
          idResolver: async (row, db) => {
            await write(db);
            return row.id;
          },
        }),
      }),
    },
    {
      kind: 'an entity enricher, through the client it receives',
      phase: 'diff-generation',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditReentrantWriteError,
      callbacksOf: (write) => ({ user: userEnrichedBy(write) }),
    },
    {
      kind: 'an entity enricher, through the $parent of the client it receives',
      phase: 'diff-generation',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditParentWriteError,
      callbacksOf: (write) => ({ user: userEnrichedBy((db) => write(parentOf(db))) }),
    },
    {
      kind: "an entity enricher whose onError is 'ignore', through the client it receives",
      phase: 'diff-generation',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditReentrantWriteError,
      callbacksOf: (write) => ({ user: userEnrichedBy(write, { onError: 'ignore' }) }),
    },
    {
      kind: "an entity enricher whose onError is 'ignore', through the $parent of the client it receives",
      phase: 'diff-generation',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditParentWriteError,
      callbacksOf: (write) => ({ user: userEnrichedBy((db) => write(parentOf(db)), { onError: 'ignore' }) }),
    },
    {
      kind: "the onError of an entity enricher whose lookup failed, through the audited client, in place of the fallback to 'log'",
      phase: 'diff-generation',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditReentrantWriteError,
      callbacksOf: (write, audited) => ({
        user: defineEntity<UserRow, Db>({
          type: 'User',
          entityContext: {
            enricher: async () => {
              throw new Error('lookup failed');
            },
            onError: async () => {
              await write(audited());
              return 'ignore' as const;
            },
          },
        }),
      }),
    },
    {
      kind: 'the writer, through the handle it receives',
      phase: 'log-write',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditReentrantWriteError,
      callbacksOf: (write) => ({
        writer: async (records, { handle, defaultWrite }) => {
          await write(handle);
          await defaultWrite(records);
        },
      }),
    },
    {
      kind: 'the writer, through the $parent of the handle it receives',
      phase: 'log-write',
      failsInTransaction: true,
      incompleteWhenAtomic: false,
      rejectedWith: AuditParentWriteError,
      callbacksOf: (write) => ({
        writer: async (records, { handle, defaultWrite }) => {
          await write(parentOf(handle));
          await defaultWrite(records);
        },
      }),
    },
  ];

  describe.each(callbackKinds)(
    'from $kind',
    ({ phase, failsInTransaction, incompleteWhenAtomic, rejectedWith, callbacksOf }) => {
      it.each(scopes.map((scope) => ({ ...scope, rejection: rejectedWith.name })))(
        'is rejected with $rejection and not written, and the operation reports it, $scope',
        async ({ mode, inTransaction }) => {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const rejections: unknown[] = [];
          const { createUser, outcomes } = createClient(mode, tagWrite(rejections), callbacksOf);

          const failure = await createUser(inTransaction).then(
            () => undefined,
            (error: unknown) => error,
          );
          await flushAllPendingWrites();

          await expectRejectedTagWrite(rejections, rejectedWith);
          const failed = mode === 'atomic' || (inTransaction && failsInTransaction);
          if (!failed) {
            expect(failure).toBeUndefined();
          } else if (mode === 'atomic' && incompleteWhenAtomic) {
            expect(failure).toBeInstanceOf(AuditIncompleteError);
            expect(failure).toMatchObject({ failures: [expect.objectContaining({ phase, error: rejections[0] })] });
          } else {
            expect(failure).toBe(rejections[0]);
          }
          expect(await basePrisma.user.count()).toBe(failed ? 0 : 1);
          expect(outcomes.map((outcome) => outcome.model)).toEqual(['User']);
          expect(outcomes[0]?.failures).toContainEqual(expect.objectContaining({ phase, error: rejections[0] }));
          expect(warn).not.toHaveBeenCalled();
        },
      );
    },
  );

  describe('from the observer, through the audited client', () => {
    it.each(scopes)(
      'is rejected with AuditReentrantWriteError and not written, without an outcome, $scope',
      async ({ mode, inTransaction }) => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rejections: unknown[] = [];
        const observed: string[] = [];
        const { createUser } = createClient(mode, tagWrite(rejections), (write, audited) => ({
          observer: async (outcome) => {
            observed.push(`${outcome.model}:${outcome.status}`);
            await write(audited());
          },
        }));

        await expect(createUser(inTransaction)).resolves.toBeUndefined();
        await flushAllPendingWrites();

        await expectRejectedTagWrite(rejections, AuditReentrantWriteError);
        expect(observed).toEqual(['User:complete']);
        expect(consoleError).toHaveBeenCalledWith(
          '[db-audit-core] Error in the audit observer:',
          (rejections[0] as Error).message,
          '(while reporting the complete outcome of create on User)',
        );
        expect(await basePrisma.user.count()).toBe(1);
      },
    );
  });

  it.each(scopes)(
    'is rejected when it writes an audited model only through a nested write, $scope',
    async ({ mode, inTransaction, transactional }) => {
      const rejections: unknown[] = [];
      const nestedTagWrite = async (db: Db): Promise<void> => {
        const author = await db.user.findUniqueOrThrow({ where: { email: 'caller@example.com' } });
        await keepingRejection(rejections, () =>
          db.post.create({
            data: {
              title: 'written by a callback',
              authorId: author.id,
              postTags: { create: { tag: { create: { name: 'written by a callback' } } } },
            },
          }),
        );
      };
      const { createUser } = createClient(mode, nestedTagWrite, (write) => ({ user: userEnrichedBy(write) }));

      const created = createUser(inTransaction);
      if (transactional) {
        await expect(created).rejects.toBeInstanceOf(AuditReentrantWriteError);
      } else {
        await expect(created).resolves.toBeUndefined();
      }
      await flushAllPendingWrites();

      expect(rejections).toEqual([expect.any(AuditReentrantWriteError)]);
      expect(rejections[0]).toMatchObject({ modelName: 'Tag', operationModelName: 'Post', operation: 'create' });
      expect(await basePrisma.post.count()).toBe(0);
      expect(await basePrisma.tag.count()).toBe(0);
    },
  );

  it.each(scopes)(
    'runs a write of a model that is not audited, from an enricher and from the writer before its default write, $scope',
    async ({ mode, inTransaction }) => {
      const labelWrite = async (db: Db): Promise<void> => {
        await db.label.create({ data: { name: 'written by a callback' } });
      };
      const { createUser, outcomes } = createClient(mode, labelWrite, (write) => ({
        user: userEnrichedBy(write),
        writer: async (records, { handle, defaultWrite }) => {
          await write(handle);
          await defaultWrite(records);
        },
      }));

      await createUser(inTransaction);
      await flushAllPendingWrites();

      expect(await basePrisma.label.count()).toBe(2);
      expect(await basePrisma.auditLog.findMany({ select: { entityType: true, action: true } })).toEqual([
        { entityType: 'User', action: 'create' },
      ]);
      expect(outcomes.map(({ model, status }) => `${model}:${status}`)).toEqual(['User:complete']);
    },
  );

  it.each(scopes)(
    'rejects with AuditParentWriteError a write of a model that is not audited through the parent of the client an enricher receives, $scope',
    async ({ mode, inTransaction, transactional }) => {
      const rejections: unknown[] = [];
      const parentLabelWrite = (db: Db): Promise<void> =>
        keepingRejection(rejections, () => parentOf(db).label.create({ data: { name: 'written by a callback' } }));
      const { createUser, outcomes } = createClient(mode, parentLabelWrite, (write) => ({
        user: userEnrichedBy(write, { onError: 'ignore' }),
      }));

      const created = createUser(inTransaction);
      if (transactional) {
        await expect(created).rejects.toBeInstanceOf(AuditParentWriteError);
      } else {
        await expect(created).resolves.toBeUndefined();
      }
      await flushAllPendingWrites();

      expect(rejections).toEqual([expect.any(AuditParentWriteError)]);
      expect(rejections[0]).toMatchObject({ modelName: 'Label', operationModelName: 'Label', operation: 'create' });
      expect(await basePrisma.label.count()).toBe(0);
      expect(outcomes[0]?.failures).toContainEqual(
        expect.objectContaining({ phase: 'diff-generation', error: rejections[0] }),
      );
    },
  );

  it.each(scopes)(
    'runs unaudited a write of an audited model through the client passed to createAuditClient, $scope',
    async ({ mode, inTransaction }) => {
      const { createUser, outcomes } = createClient(
        mode,
        async () => {},
        (_write, _audited, base) => ({
          user: userEnrichedBy(async () => {
            await base().tag.create({ data: { name: 'written through the base client' } });
          }),
        }),
      );

      await createUser(inTransaction);
      await flushAllPendingWrites();

      expect(await basePrisma.tag.count()).toBe(1);
      expect(await basePrisma.auditLog.findMany({ select: { entityType: true } })).toEqual([{ entityType: 'User' }]);
      expect(outcomes.map(({ model, status }) => `${model}:${status}`)).toEqual(['User:complete']);
    },
  );
});
