/**
 * Integration Test: fields a client-level omit hides
 *
 * A client-level `omit` decides what the client's reads return, not what the audit records: the
 * audit reads the fields it hides before and after the write, records their change, and masks
 * their values. The caller receives exactly the fields it asked for.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { type AggregateMapping, createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

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

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];

interface Options {
  readonly Prisma?: typeof Prisma;
  readonly aggregateMapping?: AggregateMapping;
  readonly security?: { readonly redact?: { readonly fields?: string[] } };
}

/** The Prisma namespace with its client version reported as `version` */
const prismaReportingVersion = (version: string | undefined): typeof Prisma =>
  new Proxy(Prisma, {
    get: (target, key) =>
      key === 'prismaVersion' ? { ...target.prismaVersion, client: version } : Reflect.get(target, key),
  });

/** The client with the internal field Prisma keeps its `omit` option in out of sight */
const hidingOmitSetting = (client: PrismaClient): PrismaClient =>
  new Proxy(client, { has: (target, key) => key !== '_globalOmit' && Reflect.has(target, key) });

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

  const setup = async (
    options: Options = {},
    clientOmit: Prisma.GlobalOmitConfig = CLIENT_OMIT,
    audited: (client: PrismaClient) => PrismaClient = (client) => client,
  ) => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, omit: clientOmit });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(audited(basePrisma), {
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
    /** `entityId:aggregateType:aggregateId` of every record of `entityType`, sorted */
    const aggregatesOf = async (entityType: string) =>
      (await basePrisma.auditLog.findMany({ where: { entityType } }))
        .map((log) => `${log.entityId}:${log.aggregateType}:${log.aggregateId}`)
        .sort();

    await basePrisma.user.create({
      data: { id: 'u1', email: 'u1@example.com', name: 'Ada', password: 'hash-old' },
    });
    await basePrisma.user.create({ data: { id: 'u2', email: 'u2@example.com', name: 'Bob' } });
    await basePrisma.post.create({ data: { id: 'p1', title: 'T1', content: 'Body', authorId: 'u1' } });

    return { basePrisma, prisma, run, recordsOf, recordOf, aggregatesOf };
  };

  it('detects the fields the client omits, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { prisma, run, recordOf } = await setup();

    await run(() => prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' } }));

    expect(warn).not.toHaveBeenCalled();
    expect((await recordOf('User', 'u1'))?.before).toMatchObject({ password: MASKED });
  });

  describe('a top-level row', () => {
    it('records a change of a hidden field masked, and returns the default fields', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

      expect(keysOf(result)).toEqual(USER_DEFAULT_COLUMNS);
      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
      expect(record?.before).toMatchObject({ password: MASKED });
      expect(record?.after).toMatchObject({ password: MASKED });
      expect(keysOf(record?.before)).toEqual(USER_COLUMNS);
      expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
    });

    it('records no change of a hidden field the update left as it was, and keeps it masked in the states', async () => {
      const { prisma, run, recordOf } = await setup();

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' } }));

      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
      expect(record?.before).toMatchObject({ password: MASKED });
      expect(record?.after).toMatchObject({ password: MASKED });
    });

    it('records a created row with its hidden field masked, and a deleted row the same way', async () => {
      const { prisma, run, recordOf } = await setup();

      const created = await run(() =>
        prisma.user.create({ data: { id: 'u3', email: 'u3@example.com', password: 'hash-new' } }),
      );
      await run(() => prisma.user.delete({ where: { id: 'u2' } }));

      expect(keysOf(created)).toEqual(USER_DEFAULT_COLUMNS);
      expect((await recordOf('User', 'u3'))?.after).toMatchObject({ password: MASKED });
      const deleted = await recordOf('User', 'u2');
      expect(keysOf(deleted?.before)).toEqual(USER_COLUMNS);
      expect(deleted?.before).toMatchObject({ password: null });
    });

    it('hands a hidden field a select names back to the caller, and records it masked, not as added', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' }, select: { id: true, password: true } }),
      );

      expect(result).toEqual({ id: 'u1', password: 'hash-old' });
      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
      expect(record?.after).toMatchObject({ password: MASKED });
    });

    it('hands a hidden field an omit sets to false back to the caller, and records it masked, not as added', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea' }, omit: { password: false } }),
      );

      expect(keysOf(result)).toEqual(USER_COLUMNS);
      expect((result as Record<string, unknown>).password).toBe('hash-old');
      expect((await recordOf('User', 'u1'))?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
    });

    it('returns exactly the selected fields while recording every column', async () => {
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' }, select: { id: true } }),
      );

      expect(result).toEqual({ id: 'u1' });
      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
      expect(keysOf(record?.after)).toEqual(USER_COLUMNS);
    });

    it('masks a hidden field the redact config also names once', async () => {
      const { prisma, run, recordOf } = await setup({ security: { redact: { fields: ['password'] } } });

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ password: { old: MASKED, new: MASKED_CHANGED } });
      expect(record?.after).toMatchObject({ password: MASKED });
    });
  });

  describe('excludeFields', () => {
    const excludingPassword: Options = {
      aggregateMapping: {
        ...testAggregateMapping,
        User: defineEntity({ type: 'User', excludeFields: ['createdAt', 'updatedAt', 'password'] }),
      },
    };

    it('records no update whose only change is an excluded hidden field', async () => {
      const { prisma, run, recordsOf } = await setup(excludingPassword);

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

      expect(await recordsOf('User')).toEqual([]);
    });

    it('leaves an excluded hidden field out of the changes, and keeps it masked in the states', async () => {
      const { prisma, run, recordOf } = await setup(excludingPassword);

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { name: 'Bea', password: 'hash-new' } }));

      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
      expect(record?.after).toMatchObject({ password: MASKED });
    });
  });

  describe('a nested row', () => {
    it('records a change of a hidden field masked under a select of the written relation', async () => {
      const { prisma, run, recordOf } = await setup();

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

    it('returns the default fields of each row of an included written relation', async () => {
      const { prisma, run, recordOf } = await setup();

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

    it('records a change of a hidden field of a row the caller include filters out', async () => {
      const { prisma, run, recordOf } = await setup();

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

    it('records a hidden foreign key a connect changes masked, under both users', async () => {
      const { prisma, run, recordOf, aggregatesOf } = await setup();

      const result = await run(() =>
        prisma.user.update({ where: { id: 'u2' }, data: { posts: { connect: { id: 'p1' } } }, select: { id: true } }),
      );

      expect(result).toEqual({ id: 'u2' });
      const record = await recordOf('Post', 'p1');
      expect(record?.changes).toEqual({ authorId: { old: MASKED, new: MASKED_CHANGED } });
      expect(record?.before).toMatchObject({ content: MASKED });
      expect(await aggregatesOf('Post')).toEqual(['p1:Post:p1', 'p1:User:u1', 'p1:User:u2']);
    });
  });

  describe('a hidden foreign key', () => {
    it('resolves the aggregate of a created row through it', async () => {
      const { prisma, run, aggregatesOf, recordOf } = await setup();

      const result = await run(() =>
        prisma.post.create({ data: { id: 'p-new', title: 'New', authorId: 'u1' }, select: { id: true } }),
      );

      expect(result).toEqual({ id: 'p-new' });
      expect(await aggregatesOf('Post')).toEqual(['p-new:Post:p-new', 'p-new:User:u1']);
      expect((await recordOf('Post', 'p-new'))?.after).toMatchObject({ authorId: MASKED });
    });

    it('resolves the aggregate of a nested deleted row through its before state', async () => {
      const { prisma, run, aggregatesOf } = await setup();

      await run(() => prisma.user.update({ where: { id: 'u1' }, data: { posts: { delete: { id: 'p1' } } } }));

      expect(await aggregatesOf('Post')).toEqual(['p1:Post:p1', 'p1:User:u1']);
    });
  });

  describe('batch operations', () => {
    it('records the rows createManyAndReturn creates with the hidden field masked, returning exactly the selected fields', async () => {
      const { prisma, run, recordOf } = await setup();

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
      const { basePrisma, prisma, run, recordsOf } = await setup();
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
      const { prisma, run, recordOf } = await setup();

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
      const { prisma, run, recordOf } = await setup();

      const result = await run(() =>
        prisma.post.updateMany({ where: { id: 'p1' }, data: { content: 'Body 2' }, ...limit }),
      );

      expect(result).toEqual({ count: 1 });
      expect((await recordOf('Post', 'p1'))?.changes).toEqual({ content: { old: MASKED, new: MASKED_CHANGED } });
    });

    it('records a row deleteMany deletes with the hidden field masked', async () => {
      const { prisma, run, recordOf } = await setup();

      await run(() => prisma.post.deleteMany({ where: { id: 'p1' } }));

      const record = await recordOf('Post', 'p1');
      expect(keysOf(record?.before)).toEqual(POST_COLUMNS);
      expect(record?.before).toMatchObject({ content: MASKED, authorId: MASKED });
    });
  });

  describe('a client whose omit setting cannot be read', () => {
    const SECRETS = ['hash-old', 'hash-new'];
    const everyColumnMasked = Object.fromEntries(USER_COLUMNS.map((column) => [column, MASKED]));

    it.each([
      ['before 6.2', '6.1.0'],
      ['of an unknown version', undefined],
    ])(
      'masks every column of a row a select is read by listing every column on a client %s, and warns',
      async (_label, version) => {
        const warn = vi.spyOn(console, 'warn');
        const { prisma, run, recordOf } = await setup(
          { Prisma: prismaReportingVersion(version) },
          CLIENT_OMIT,
          hidingOmitSetting,
        );

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
        expect(record?.after).toEqual(everyColumnMasked);
        expect(Object.keys(record?.changes ?? {}).sort()).toEqual(['name', 'password']);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('every column value is masked');
      },
    );

    it('reads the default shape of a client from 6.2, leaving the hidden field out, and warns', async () => {
      const warn = vi.spyOn(console, 'warn');
      const { prisma, run, recordOf } = await setup({}, CLIENT_OMIT, hidingOmitSetting);

      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { name: 'Bea', password: 'hash-new' },
          select: { name: true },
        }),
      );

      const record = await recordOf('User', 'u1');
      expect(keysOf(record?.before)).toEqual(USER_DEFAULT_COLUMNS);
      expect(keysOf(record?.after)).toEqual(USER_DEFAULT_COLUMNS);
      expect(record?.changes).toEqual({ name: { old: 'Ada', new: 'Bea' } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('left out of audit logs');
    });

    it('masks only the hidden field when the setting is readable on a client before 6.2', async () => {
      const warn = vi.spyOn(console, 'warn');
      const { prisma, run, recordOf } = await setup({ Prisma: prismaReportingVersion('6.1.0') });

      await run(() =>
        prisma.user.update({
          where: { id: 'u1' },
          data: { name: 'Bea', password: 'hash-new' },
          select: { name: true },
        }),
      );

      const record = await recordOf('User', 'u1');
      expect(record?.changes).toEqual({
        name: { old: 'Ada', new: 'Bea' },
        password: { old: MASKED, new: MASKED_CHANGED },
      });
      expect(record?.after).toMatchObject({ name: 'Bea', password: MASKED });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('a client without omit', () => {
    it('records every column as it reads it, masking nothing it was not told to', async () => {
      const { prisma, run, recordOf } = await setup({}, {});

      const result = await run(() => prisma.user.update({ where: { id: 'u1' }, data: { password: 'hash-new' } }));

      expect(keysOf(result)).toEqual(USER_COLUMNS);
      expect((await recordOf('User', 'u1'))?.changes).toEqual({ password: { old: 'hash-old', new: 'hash-new' } });
    });
  });
});
