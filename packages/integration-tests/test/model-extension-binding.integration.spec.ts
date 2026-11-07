/**
 * Integration Test: a model method an extension adds, applied to the audited client or before the
 * audit
 *
 * A model component (`$extends({ model: { user: { signUp } } })`) calls the model's delegate
 * through `Prisma.getExtensionContext(this)`. On the audited client the write it makes is bound to
 * that client, outside any transaction; called as `tx.user.signUp()` inside `$transaction`, it is
 * bound to that transaction, and its audit row commits and rolls back with it.
 *
 * The extension context's `$parent` is Prisma's: the client one level below the client the method
 * was called on, with the methods of the extensions applied below it. Called on a client an
 * extension applied after the audit adds, it is at or above the level the audit was applied to,
 * and a write through it is audited. Called on the audited client, it is below the audit, and
 * every write through it is rejected with `AuditParentWriteError` before it runs.
 *
 * A method of an extension applied before the audit that is named after a built-in action
 * (`create`, `update`, ...) runs with Prisma's own delegate as `this`, which the audit does not
 * wrap: a write it makes through the extension context's `$parent` runs unaudited and is not
 * rejected. Overriding a built-in action that way is unsupported.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { WriteMode } from '@kuruwic/prisma-audit';
import { AuditParentWriteError, createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'model-extension-binding-actor' },
};

describe('a model method an extension applied to the audited client adds', () => {
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();

  const createClient = (base: PrismaClient) =>
    createAuditClient(base, testAuditOptions(provider, { Prisma, schema: auditSchema })).$extends({
      client: {
        async signUpThroughClientParent(email: string) {
          return Prisma.getExtensionContext(this).$parent.user.create({
            data: { email, name: 'Signed up', password: 'secret123' },
          });
        },
      },
      model: {
        user: {
          async signUp(email: string) {
            return Prisma.getExtensionContext(this).create({
              data: { email, name: 'Signed up', password: 'secret123' },
            });
          },
          async signUpThroughParent(email: string) {
            return Prisma.getExtensionContext(this).$parent.user.create({
              data: { email, name: 'Signed up', password: 'secret123' },
            });
          },
        },
      },
    });

  const withParentMethod = (client: ReturnType<typeof createClient>) =>
    client.$extends({
      model: {
        user: {
          async signUpThroughParentMethod(email: string) {
            return Prisma.getExtensionContext(this).$parent.user.signUp(email);
          },
        },
      },
    });

  let prisma: ReturnType<typeof createClient>;
  let layered: ReturnType<typeof withParentMethod>;

  beforeAll(() => {
    basePrisma = createBasePrisma();
    prisma = createClient(basePrisma);
    layered = withParentMethod(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
  });

  const userCreateLogs = async () => {
    await flushAllPendingWrites();
    return basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } });
  };

  it('audits the write of a model method called on the audited client outside any transaction', async () => {
    const user = await provider.runAsync(testActor, () => prisma.user.signUp('outside@example.com'));

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });

  it('audits the write of a model method called on the client a $transaction callback receives in that transaction, and rolls it back with it', async () => {
    const rollback = new Error('callback rolls back');
    let auditRowsInTransaction: number | undefined;

    await expect(
      provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.signUp('inside@example.com');
          auditRowsInTransaction = await tx.auditLog.count({ where: { entityType: 'User', action: 'create' } });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    expect(auditRowsInTransaction).toBe(1);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await userCreateLogs()).toEqual([]);
  });

  it("audits the write a model method makes through the extension context's $parent, outside any transaction", async () => {
    const user = await provider.runAsync(testActor, () => prisma.user.signUpThroughParent('parent@example.com'));

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });

  it("audits the write of a method of the extension below, which the extension context's $parent keeps, outside any transaction", async () => {
    const user = await provider.runAsync(testActor, () =>
      layered.user.signUpThroughParentMethod('parent-method@example.com'),
    );

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });

  it("audits the write a client method makes through the extension context's $parent, outside any transaction", async () => {
    const user = await provider.runAsync(testActor, () =>
      prisma.signUpThroughClientParent('client-parent@example.com'),
    );

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });

  it("audits the write a model method makes through the extension context's $parent in the transaction of the client a $transaction callback receives, and rolls it back with it", async () => {
    const rollback = new Error('callback rolls back');
    let auditRowsInTransaction: number | undefined;

    await expect(
      provider.runAsync(testActor, () =>
        prisma.$transaction(async (tx) => {
          await tx.user.signUpThroughParent('parent-inside@example.com');
          auditRowsInTransaction = await tx.auditLog.count({ where: { entityType: 'User', action: 'create' } });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);

    expect(auditRowsInTransaction).toBe(1);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await userCreateLogs()).toEqual([]);
  });

  it('commits the write of a model method called on the client a $transaction callback receives together with its audit row', async () => {
    const user = await provider.runAsync(testActor, () =>
      prisma.$transaction(async (tx) => tx.user.signUp('committed@example.com')),
    );

    expect((await userCreateLogs()).map((log) => log.entityId)).toEqual([user.id]);
  });
});

describe('a model method an extension applied before the audit adds', () => {
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();

  const createClient = (base: PrismaClient, mode: WriteMode) =>
    createAuditClient(
      base.$extends({
        model: {
          user: {
            async signUp(email: string) {
              return Prisma.getExtensionContext(this).create({
                data: { email, name: 'Signed up', password: 'secret123' },
              });
            },
            async publishThroughParent(authorId: string, title: string) {
              return Prisma.getExtensionContext(this).$parent.post.create({ data: { title, authorId } });
            },
          },
        },
      }),
      { ...testAuditOptions(provider, { Prisma, schema: auditSchema }), write: { mode } },
    );

  beforeAll(() => {
    basePrisma = createBasePrisma();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
  });

  /** The create logs of `entityType` as its own aggregate: a `Post` has another under its author */
  const createLogs = async (entityType: string) => {
    await flushAllPendingWrites();
    return basePrisma.auditLog.findMany({ where: { entityType, aggregateType: entityType, action: 'create' } });
  };

  const createAuthor = () =>
    basePrisma.user.create({ data: { email: 'author@example.com', name: 'Author', password: 'secret123' } });

  it('audits the write a model method makes through Prisma.getExtensionContext(this), called on the audited client outside any transaction', async () => {
    const prisma = createClient(basePrisma, 'awaited');

    const user = await provider.runAsync(testActor, () => prisma.user.signUp('before-context@example.com'));

    expect((await createLogs('User')).map((log) => log.entityId)).toEqual([user.id]);
  });

  describe.each(['awaited', 'atomic'] as const)('under %s', (mode) => {
    it("rejects with AuditParentWriteError the write of another audited model a model method makes through the extension context's $parent, called on the audited client outside any transaction, and writes nothing", async () => {
      const prisma = createClient(basePrisma, mode);
      const author = await createAuthor();

      const published = provider.runAsync(testActor, () => prisma.user.publishThroughParent(author.id, 'Outside'));

      await expect(published).rejects.toThrow(AuditParentWriteError);
      await expect(published).rejects.toMatchObject({
        modelName: 'Post',
        operationModelName: 'Post',
        operation: 'create',
      });
      expect(await basePrisma.post.count()).toBe(0);
      expect(await createLogs('Post')).toEqual([]);
    });

    it("rejects with AuditParentWriteError the write a model method makes through the extension context's $parent, called on the client a $transaction callback receives, and writes nothing", async () => {
      const prisma = createClient(basePrisma, mode);
      const author = await createAuthor();

      await expect(
        provider.runAsync(testActor, () =>
          prisma.$transaction(async (tx) => {
            await tx.user.publishThroughParent(author.id, 'Inside');
          }),
        ),
      ).rejects.toThrow(AuditParentWriteError);

      expect(await basePrisma.post.count()).toBe(0);
      expect(await createLogs('Post')).toEqual([]);
    });
  });

  it("runs unaudited, without rejecting it, the write a method named after a built-in action makes through the extension context's $parent: Prisma calls it with its own delegate as this", async () => {
    const prisma = createAuditClient(
      basePrisma.$extends({
        model: {
          tag: {
            async create(args: { data: { name: string } }) {
              return Prisma.getExtensionContext(this).$parent.tag.create(args);
            },
          },
        },
      }),
      testAuditOptions(provider, { Prisma, schema: auditSchema }),
    );

    await provider.runAsync(testActor, () => prisma.tag.create({ data: { name: 'overridden' } }));

    expect((await basePrisma.tag.findMany()).map((tag) => tag.name)).toEqual(['overridden']);
    expect(await createLogs('Tag')).toEqual([]);
  });
});
