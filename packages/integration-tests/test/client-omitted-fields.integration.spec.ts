/**
 * Integration Test: fields a client-level omit hides
 *
 * By default the audit records the client's default shape: a field a client-level `omit` hides is
 * neither read nor recorded. An entity lists the hidden fields to audit in `auditOmittedFields`:
 * the audit reads them in its own queries, the read before the write and a read by primary key
 * after it, records their change, and masks their values. The caller receives exactly the fields
 * it asked for either way.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import {
  type AggregateMapping,
  type AuditErrorObserver,
  createAuditClient,
  defineEntity,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aggregatesOf, cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'client-omitted-fields-actor' },
};

const MASKED = { redacted: true, hadValue: true };
const MASKED_CHANGED = { redacted: true, hadValue: true, isDifferent: true };

const CLIENT_OMIT: Prisma.GlobalOmitConfig = { user: { password: true }, post: { content: true, authorId: true } };

const USER_COLUMNS = ['createdAt', 'email', 'id', 'name', 'password', 'updatedAt'];
const POST_COLUMNS = ['authorId', 'content', 'createdAt', 'id', 'published', 'title', 'updatedAt'];
const USER_DEFAULT_COLUMNS = USER_COLUMNS.filter((column) => column !== 'password');
const POST_DEFAULT_COLUMNS = POST_COLUMNS.filter((column) => column !== 'content' && column !== 'authorId');

const SECRETS = ['hash-old', 'hash-new'];

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];

/** The two ways a caller reads the hidden password: a select naming it, an omit setting it to false */
const CALLER_NAMED_PASSWORD: Array<[string, Pick<Prisma.UserUpdateArgs, 'select' | 'omit'>]> = [
  ['a select names', { select: { id: true, password: true } }],
  ['an omit sets to false', { omit: { password: false } }],
];

/** The mapping whose User and Post audit the fields the client omits */
const auditingOmittedFields: AggregateMapping = {
  ...testAggregateMapping,
  User: defineEntity({ type: 'User', excludeFields: ['updatedAt'], auditOmittedFields: ['password'] }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
    auditOmittedFields: ['content', 'authorId'],
  }),
};

interface Options {
  readonly Prisma?: typeof Prisma;
  readonly errorHandling?: { readonly observer?: AuditErrorObserver };
  readonly aggregateMapping?: AggregateMapping;
  readonly security?: { readonly redact?: { readonly fields?: string[] } };
}

/** The Prisma namespace with its client version reported as `version` */
const prismaReportingVersion = (version: string | undefined): typeof Prisma =>
  new Proxy(Prisma, {
    get: (target, key) =>
      key === 'prismaVersion' ? { ...target.prismaVersion, client: version } : Reflect.get(target, key),
  });

describe('fields a client-level omit hides', () => {
  let databaseUrl: string;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async (options: Options = {}, clientOmit: Prisma.GlobalOmitConfig = CLIENT_OMIT) => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, omit: clientOmit });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      ...options,
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const recordsOf = async (entityType: string) =>
      basePrisma.auditLog.findMany({ where: { entityType, aggregateType: entityType }, orderBy: { entityId: 'asc' } });
    const recordOf = async (entityType: string, entityId: string) => {
      const records = await basePrisma.auditLog.findMany({
        where: { entityType, entityId, aggregateType: entityType },
      });
      expect(records).toHaveLength(1);
      return records[0];
    };

    await basePrisma.user.create({
      data: { id: 'u1', email: 'u1@example.com', name: 'Ada', password: 'hash-old' },
    });
    await basePrisma.user.create({ data: { id: 'u2', email: 'u2@example.com', name: 'Bob' } });
    await basePrisma.post.create({ data: { id: 'p1', title: 'T1', content: 'Body', authorId: 'u1' } });

    return { basePrisma, prisma, run, recordsOf, recordOf };
  };

  const optedIn = (options: Options = {}) => setup({ aggregateMapping: auditingOmittedFields, ...options });

  describe('by default', () => {
    it('records no update whose only change is to a hidden field, and returns the default fields', async () => {
      const { prisma, run, recordsOf } = await setup();

      const result = await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

      expect(keysOf(result)).toEqual(USER_DEFAULT_COLUMNS);
      expect(await recordsOf('User')).toEqual([]);
    });

    it('records the default fields of an updated row, without the hidden field', async () => {
      const { prisma, run, recordOf } = await setup();

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea', password: 'hash-new' } }));

      const record = await recordOf('User', 'u1');
      expect(keysOf(record?.before)).toEqual(USER_DEFAULT_COLUMNS);
      expect(keysOf(record?.after)).toEqual(USER_DEFAULT_COLUMNS);
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
    });

    it('records a created and a deleted row in the default fields', async () => {
      const { prisma, run, recordOf } = await setup();

      await run(() => prisma.user.create({ data: { id: 'u3', email: 'u3@example.com', password: 'hash-new' } }));
      await run(() => prisma.user.delete({ where: { id: 'u1' } }));

      expect(keysOf((await recordOf('User', 'u3'))?.after)).toEqual(USER_DEFAULT_COLUMNS);
      const deleted = await recordOf('User', 'u1');
      expect(keysOf(deleted?.before)).toEqual(USER_DEFAULT_COLUMNS);
      for (const secret of SECRETS) {
        expect(JSON.stringify(deleted)).not.toContain(secret);
      }
    });

    it.each(CALLER_NAMED_PASSWORD)(
      'hands a hidden field %s back to the caller without recording it',
      async (_label, selection) => {
        const { prisma, run, recordOf } = await setup();

        const result = await run(() =>
          prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea', password: 'hash-new' }, ...selection }),
        );

        expect((result as Record<string, unknown>).password).toBe('hash-new');
        const record = await recordOf('User', 'u1');
        expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
        expect(keysOf(record?.after)).toEqual(USER_DEFAULT_COLUMNS);
        for (const secret of SECRETS) {
          expect(JSON.stringify(record)).not.toContain(secret);
        }
      },
    );

    it('records no nested update whose only change is to a hidden field, returning exactly the selection', async () => {
      const { prisma, run, recordsOf } = await setup();

      const result = await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { posts: { update: { where: { id: 'p1' }, data: { content: 'Body 2' } } } },
          select: { id: true, posts: { select: { id: true } } },
        }),
      );

      expect(result).toEqual({ id: 'u1', posts: [{ id: 'p1' }] });
      expect(await recordsOf('Post')).toEqual([]);
    });

    it('records the rows createManyAndReturn creates in the default fields, returning exactly the selection', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.createManyAndReturn({
          data: [{ id: 'u3', email: 'u3@example.com', password: 'hash-new' }],
          select: { id: true },
        }),
      );

      expect(result).toEqual([{ id: 'u3' }]);
      expect(keysOf((await recordOf('User', 'u3'))?.after)).toEqual(USER_DEFAULT_COLUMNS);
    });

    it('fails a foreignKey root on a hidden column the entity does not list, naming the option, and records the row under its own root', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { basePrisma, prisma, run } = await setup({ errorHandling: { observer } });

      await run(() => prisma.post.update({ where: { id: 'p1' }, data: { title: 'T1b' } }));

      expect(await aggregatesOf(basePrisma, 'Post')).toEqual(['p1:Post:p1']);
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'id-resolver-call',
          modelName: 'Post',
          params: expect.objectContaining({ resolver: expect.objectContaining({ aggregateType: 'User' }) }),
          error: expect.objectContaining({ message: expect.stringContaining('auditOmittedFields') }),
        }),
      );
    });
  });

  it('fails a foreignKey root on a hidden column of a nested deleted row the same way, recording it under its own root only', async () => {
    const observer = vi.fn<AuditErrorObserver>();
    const { basePrisma, prisma, run } = await setup({ errorHandling: { observer } });

    await run(() => prisma.user.update({ where: { id: 'u1' }, data: { posts: { delete: { id: 'p1' } } } }));

    expect(await aggregatesOf(basePrisma, 'Post')).toEqual(['p1:Post:p1']);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'id-resolver-call', modelName: 'Post' }));
  });

  describe('fields an entity lists in auditOmittedFields', () => {
    describe('a top-level row', () => {
      it('records a change of a listed field masked, and returns the default fields', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

        expect(keysOf(result)).toEqual(USER_DEFAULT_COLUMNS);
        const record = await recordOf('User', 'u1');
        expect(record?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
        expect(record?.before).toMatchObject({ password: MASKED });
        expect(record?.after).toMatchObject({ password: MASKED });
        expect(keysOf(record?.before)).toEqual(USER_COLUMNS);
        expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
      });

      it('records no change of a listed field the update left as it was, and keeps it masked in the states', async () => {
        const { prisma, run, recordOf } = await optedIn();

        await run(() => prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' } }));

        const record = await recordOf('User', 'u1');
        expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
        expect(record?.before).toMatchObject({ password: MASKED });
        expect(record?.after).toMatchObject({ password: MASKED });
      });

      it('records a created row with its listed field masked, and a deleted row the same way', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const created = await run(() =>
          prisma.user.create({ data: { id: 'u3', email: 'u3@example.com', password: 'hash-new' } }),
        );
        await run(() => prisma.user.delete({ where: { id: 'u1' } }));

        expect(keysOf(created)).toEqual(USER_DEFAULT_COLUMNS);
        expect((await recordOf('User', 'u3'))?.after).toMatchObject({ password: MASKED });
        const deleted = await recordOf('User', 'u1');
        expect(keysOf(deleted?.before)).toEqual(USER_COLUMNS);
        expect(deleted?.before).toMatchObject({ password: MASKED });
      });

      it('records an upsert of either branch with its listed field masked', async () => {
        const { prisma, run, recordOf } = await optedIn();

        await run(() =>
          prisma.user.upsert({
            where: { id: 'u1' },
            create: { id: 'u1', email: 'u1@example.com' },
            update: { password: 'hash-new' },
            select: { id: true },
          }),
        );
        await run(() =>
          prisma.user.upsert({
            where: { id: 'u3' },
            create: { id: 'u3', email: 'u3@example.com', password: 'hash-new' },
            update: {},
            select: { id: true },
          }),
        );

        expect((await recordOf('User', 'u1'))?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
        expect((await recordOf('User', 'u3'))?.after).toMatchObject({ password: MASKED });
      });

      it.each(CALLER_NAMED_PASSWORD)(
        'hands a listed field %s back to the caller, and records it masked, not as added',
        async (_label, selection) => {
          const { prisma, run, recordOf } = await optedIn();

          const result = await run(() =>
            prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' }, ...selection }),
          );

          expect((result as Record<string, unknown>).password).toBe('hash-old');
          const record = await recordOf('User', 'u1');
          expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
          expect(record?.after).toMatchObject({ password: MASKED });
        },
      );

      it('returns exactly the selected fields while recording the listed field', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' }, select: { id: true } }),
        );

        expect(result).toEqual({ id: 'u1' });
        const record = await recordOf('User', 'u1');
        expect(record?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
        expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
      });

      it('masks a listed field the redact config also names once', async () => {
        const { prisma, run, recordOf } = await optedIn({ security: { redact: { fields: ['password'] } } });

        await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

        const record = await recordOf('User', 'u1');
        expect(record?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
        expect(record?.after).toMatchObject({ password: MASKED });
      });
    });

    describe('a field excludeFields also names', () => {
      const excludingPassword: Options = {
        aggregateMapping: {
          ...auditingOmittedFields,
          User: defineEntity({
            type: 'User',
            excludeFields: ['createdAt', 'updatedAt', 'password'],
            auditOmittedFields: ['password'],
          }),
        },
      };

      it('records no update whose only change is to it', async () => {
        const { prisma, run, recordsOf } = await setup(excludingPassword);

        await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

        expect(await recordsOf('User')).toEqual([]);
      });

      it('leaves it out of the changes and of the states', async () => {
        const { prisma, run, recordOf } = await setup(excludingPassword);

        await run(() => prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea', password: 'hash-new' } }));

        const record = await recordOf('User', 'u1');
        expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
        expect(keysOf(record?.before)).toEqual(USER_DEFAULT_COLUMNS);
        expect(keysOf(record?.after)).toEqual(USER_DEFAULT_COLUMNS);
      });
    });

    describe('a nested row', () => {
      it('records a change of a listed field masked under a select of the written relation', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.user.update({
            where: { id: 'u1' },
            data: { posts: { update: { where: { id: 'p1' }, data: { content: 'Body 2' } } } },
            select: { id: true, posts: { select: { id: true } } },
          }),
        );

        expect(result).toEqual({ id: 'u1', posts: [{ id: 'p1' }] });
        const record = await recordOf('Post', 'p1');
        expect(record?.changes).toEqual({ content: { old: MASKED, new: MASKED_CHANGED } });
        expect(keysOf(record?.before)).toEqual(POST_COLUMNS);
        expect(record?.after).toMatchObject({ content: MASKED, authorId: MASKED });
      });

      it('records a nested created row with its listed fields masked, returning exactly the selection', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.user.update({
            where: { id: 'u1' },
            data: { posts: { create: { id: 'p2', title: 'T2', content: 'Body' } } },
            select: { id: true },
          }),
        );

        expect(result).toEqual({ id: 'u1' });
        const record = await recordOf('Post', 'p2');
        expect(keysOf(record?.after)).toEqual(POST_COLUMNS);
        expect(record?.after).toMatchObject({ content: MASKED, authorId: MASKED });
      });

      it('returns the default fields of each row of an included written relation', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.user.update({
            where: { id: 'u1' },
            data: { posts: { update: { where: { id: 'p1' }, data: { title: 'T1b' } } } },
            include: { posts: true },
          }),
        );

        expect(keysOf(result)).toEqual([...USER_DEFAULT_COLUMNS, 'posts'].sort());
        expect(result.posts.map((post) => keysOf(post))).toEqual([POST_DEFAULT_COLUMNS]);
        expect((await recordOf('Post', 'p1'))?.changes).toEqual({ title: { old: 'T1', new: 'T1b' } });
      });

      it('records a change of a listed field of a row the caller include filters out', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.user.update({
            where: { id: 'u1' },
            data: { posts: { update: { where: { id: 'p1' }, data: { content: 'Body 2' } } } },
            include: { posts: { where: { title: 'none' } } },
          }),
        );

        expect(keysOf(result)).toEqual([...USER_DEFAULT_COLUMNS, 'posts'].sort());
        expect(result.posts).toEqual([]);
        expect((await recordOf('Post', 'p1'))?.changes).toEqual({ content: { old: MASKED, new: MASKED_CHANGED } });
      });

      it('records a listed foreign key a connect changes masked, under both users', async () => {
        const { basePrisma, prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.user.update({ where: { id: 'u2' }, data: { posts: { connect: { id: 'p1' } } }, select: { id: true } }),
        );

        expect(result).toEqual({ id: 'u2' });
        const record = await recordOf('Post', 'p1');
        expect(record?.changes).toEqual({ authorId: { old: MASKED, new: MASKED_CHANGED } });
        expect(record?.before).toMatchObject({ content: MASKED });
        expect(await aggregatesOf(basePrisma, 'Post')).toEqual(['p1:Post:p1', 'p1:User:u1', 'p1:User:u2']);
      });
    });

    describe('a listed foreign key', () => {
      it('resolves the aggregate of a created row through it', async () => {
        const { basePrisma, prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.post.create({ data: { id: 'p-new', title: 'New', authorId: 'u1' }, select: { id: true } }),
        );

        expect(result).toEqual({ id: 'p-new' });
        expect(await aggregatesOf(basePrisma, 'Post')).toEqual(['p-new:Post:p-new', 'p-new:User:u1']);
        expect((await recordOf('Post', 'p-new'))?.after).toMatchObject({ authorId: MASKED });
      });

      it('resolves the aggregate of a nested deleted row through its before state', async () => {
        const { basePrisma, prisma, run } = await optedIn();

        await run(() => prisma.user.update({ where: { id: 'u1' }, data: { posts: { delete: { id: 'p1' } } } }));

        expect(await aggregatesOf(basePrisma, 'Post')).toEqual(['p1:Post:p1', 'p1:User:u1']);
      });

      it('reports nothing for a row whose nullable foreign key holds null', async () => {
        const observer = vi.fn<AuditErrorObserver>();
        const { basePrisma, prisma, run } = await setup(
          {
            errorHandling: { observer },
            aggregateMapping: {
              ...testAggregateMapping,
              Label: defineEntity({
                type: 'Label',
                aggregates: [to('Post', foreignKey('postId'))],
                auditOmittedFields: ['postId'],
              }),
            },
          },
          { ...CLIENT_OMIT, label: { postId: true } },
        );

        await run(() => prisma.label.create({ data: { id: 'l1', name: 'Loose' } }));
        await run(() => prisma.label.update({ where: { id: 'l1' }, data: { name: 'Still loose' } }));
        await run(() => prisma.label.create({ data: { id: 'l2', name: 'Tied', postId: 'p1' } }));

        expect(observer).not.toHaveBeenCalled();
        expect(await aggregatesOf(basePrisma, 'Label')).toEqual([
          'l1:Label:l1',
          'l1:Label:l1',
          'l2:Label:l2',
          'l2:Post:p1',
        ]);
      });
    });

    describe('batch operations', () => {
      it('records the rows createManyAndReturn creates with the listed field masked, returning exactly the selected fields', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const selected = await run(() =>
          prisma.user.createManyAndReturn({
            data: [{ id: 'u3', email: 'u3@example.com', password: 'hash-new' }],
            select: { id: true },
          }),
        );
        const whole = await run(() =>
          prisma.user.createManyAndReturn({ data: [{ id: 'u4', email: 'u4@example.com', password: 'hash-new' }] }),
        );

        expect(selected.map((row) => keysOf(row))).toEqual([['id']]);
        expect(whole.map((row) => keysOf(row))).toEqual([USER_DEFAULT_COLUMNS]);
        expect((await recordOf('User', 'u3'))?.after).toMatchObject({ password: MASKED });
        expect(keysOf((await recordOf('User', 'u4'))?.after)).toEqual(USER_COLUMNS);
      });

      it('records the masked change of each row a limited updateManyAndReturn updates, returning exactly the selected fields', async () => {
        const { basePrisma, prisma, run, recordsOf } = await optedIn();
        await basePrisma.post.create({ data: { id: 'p2', title: 'T2', content: 'Body', authorId: 'u1' } });

        const result = await run(() =>
          prisma.post.updateManyAndReturn({
            where: { title: { in: ['T1', 'T2'] } },
            data: { content: 'Body 2' },
            limit: 2,
            select: { id: true },
          }),
        );

        expect(result.map((row) => keysOf(row))).toEqual([['id'], ['id']]);
        const records = await recordsOf('Post');
        expect(records.map((record) => record.changes)).toEqual([
          { content: { old: MASKED, new: MASKED_CHANGED } },
          { content: { old: MASKED, new: MASKED_CHANGED } },
        ]);
      });

      it('records the masked change of each row updateManyAndReturn updates, returning the default fields of each', async () => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.post.updateManyAndReturn({ where: { id: 'p1' }, data: { content: 'Body 2' } }),
        );

        expect(result.map((row) => keysOf(row))).toEqual([POST_DEFAULT_COLUMNS]);
        expect((await recordOf('Post', 'p1'))?.changes).toEqual({ content: { old: MASKED, new: MASKED_CHANGED } });
      });

      it.each([
        ['without a limit', {}],
        ['with a limit', { limit: 1 }],
      ])('records the masked change of a row updateMany updates %s', async (_label, limit) => {
        const { prisma, run, recordOf } = await optedIn();

        const result = await run(() =>
          prisma.post.updateMany({ where: { id: 'p1' }, data: { content: 'Body 2' }, ...limit }),
        );

        expect(result).toEqual({ count: 1 });
        expect((await recordOf('Post', 'p1'))?.changes).toEqual({ content: { old: MASKED, new: MASKED_CHANGED } });
      });

      it('records a row deleteMany deletes with the listed fields masked', async () => {
        const { prisma, run, recordOf } = await optedIn();

        await run(() => prisma.post.deleteMany({ where: { id: 'p1' } }));

        const record = await recordOf('Post', 'p1');
        expect(keysOf(record?.before)).toEqual(POST_COLUMNS);
        expect(record?.before).toMatchObject({ content: MASKED, authorId: MASKED });
      });
    });

    describe('configuration errors', () => {
      const listing = (auditOmittedFields: string[]): Options => ({
        aggregateMapping: {
          ...testAggregateMapping,
          User: defineEntity({ type: 'User', excludeFields: ['updatedAt'], auditOmittedFields }),
        },
      });

      it('rejects a field the model does not have', async () => {
        await expect(setup(listing(['passwrod']))).rejects.toThrow(/User.*auditOmittedFields.*passwrod/);
      });

      it('rejects a relation field', async () => {
        await expect(setup(listing(['posts']))).rejects.toThrow(/User.*auditOmittedFields.*posts/);
      });

      it('rejects the option on a mapping key that names no model', async () => {
        const options: Options = {
          aggregateMapping: {
            ...testAggregateMapping,
            Usr: defineEntity({ type: 'Usr', auditOmittedFields: ['password'] }),
          },
        };

        await expect(setup(options)).rejects.toThrow(/'Usr'.*auditOmittedFields.*matches no model/);
      });

      it.each([
        ['before 6.2', '6.1.0'],
        ['of an unknown version', undefined],
      ])('rejects the option on a client %s, which takes no query omit', async (_label, version) => {
        await expect(setup({ ...listing(['password']), Prisma: prismaReportingVersion(version) })).rejects.toThrow(
          /auditOmittedFields.*Prisma 6\.2/,
        );
      });
    });
  });

  describe('a client that takes no query omit, which reads a select by listing every column', () => {
    it.each([
      ['before 6.2', '6.1.0'],
      ['of an unknown version', undefined],
    ])('records an updated row %s in the columns its before state holds, in clear', async (_label, version) => {
      const { prisma, run, recordOf } = await setup({ Prisma: prismaReportingVersion(version) });

      const result = await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { name: 'Bea', password: 'hash-new' },
          select: { name: true },
        }),
      );

      expect(result).toEqual({ name: 'Bea' });
      const record = await recordOf('User', 'u1');
      for (const secret of SECRETS) {
        expect(JSON.stringify(record)).not.toContain(secret);
      }
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
      expect(keysOf(record?.after)).toEqual(USER_DEFAULT_COLUMNS);
      expect(record?.after).toMatchObject({ email: 'u1@example.com', name: 'Bea' });
    });

    it.each([
      ['before 6.2', '6.1.0'],
      ['of an unknown version', undefined],
    ])('records a created row %s in the columns the select names only', async (_label, version) => {
      const { prisma, run, recordOf } = await setup({ Prisma: prismaReportingVersion(version) });

      const result = await run(() =>
        prisma.user.create({ data: { id: 'u3', email: 'u3@example.com', password: 'hash-new' }, select: { id: true } }),
      );

      expect(result).toEqual({ id: 'u3' });
      const record = await recordOf('User', 'u3');
      expect(JSON.stringify(record)).not.toContain('hash-new');
      expect(keysOf(record?.after)).toEqual(['id']);
    });
  });

  describe('a client without omit', () => {
    it('records every column as it reads it, masking nothing it was not told to', async () => {
      const { prisma, run, recordOf } = await setup({}, {});

      const result = await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

      expect(keysOf(result)).toEqual(USER_COLUMNS);
      expect((await recordOf('User', 'u1'))?.changes).toEqual({ password: { old: 'hash-old', new: 'hash-new' } });
    });

    it('records every column of a row whose operation selects some of them', async () => {
      const { prisma, run, recordOf } = await setup({}, {});

      const updated = await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { name: 'Bea', password: 'hash-new' },
          select: { id: true, name: true },
        }),
      );
      const created = await run(() =>
        prisma.user.create({
          data: { id: 'u3', email: 'u3@example.com', password: 'hash-3' },
          select: { id: true, email: true },
        }),
      );

      expect(updated).toEqual({ id: 'u1', name: 'Bea' });
      expect(created).toEqual({ id: 'u3', email: 'u3@example.com' });
      const record = await recordOf('User', 'u1');
      expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
      expect(record?.changes).toEqual({
        name: { old: 'Ada', new: 'Bea' },
        password: { old: 'hash-old', new: 'hash-new' },
      });
      expect((await recordOf('User', 'u3'))?.after).toMatchObject({ email: 'u3@example.com', password: 'hash-3' });
    });
  });
});
