/**
 * Tests for the checkpoints placed after the query extensions applied after the audit: a continued
 * write reaches the database through every checkpoint once (again only after a failed attempt), and
 * a rejection names the extension at fault. Clients are simulated as Prisma runs them: each
 * extension's callback followed by its checkpoint, the last continuing to the database.
 */

import { describe, expect, it } from 'vitest';
import { AuditExtensionContinuationError, AuditUnboundWriteError } from '../../src/errors.js';
import type { ExtensionParams } from '../../src/internal-types.js';
import { createExtensionCheckpoints, type ExtensionCheckpoint } from '../../src/runtime/extension-checkpoint.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true }),
    column('email', { isUnique: true }),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
  ]),
  model('Post', [column('id', { isId: true }), column('title')]),
);

const checkpoints = createExtensionCheckpoints(schemaMetadata);

type Callback = (params: ExtensionParams) => Promise<unknown>;

interface Extension {
  readonly name?: string;
  readonly callback: Callback;
}

const passingOn: Callback = ({ args, query }) => query(args);

const database = (fails: (args: unknown) => boolean = () => false) => {
  const sent: unknown[] = [];
  const run = async (args: unknown): Promise<unknown> => {
    sent.push(args);
    if (fails(args)) {
      throw new Error('unique constraint failed');
    }
    return { id: 'u1' };
  };
  return { sent, run };
};

const clientWith = (...extensions: readonly Extension[]) => {
  let innermost: ExtensionCheckpoint | undefined;
  const callbacks: Callback[] = [];
  for (const { name, callback } of extensions) {
    const placed = checkpoints.checkpointAfter(name, innermost);
    expect(placed.extension.name).toBe('prisma-audit-checkpoint');
    callbacks.push(callback, placed.extension.query.$allOperations);
    innermost = placed.checkpoint;
  }
  return { callbacks, innermost };
};

/** The write the audit continues as a `User.update` through `client`, with the tracker of whether it reached the database */
const checkedWrite = (
  client: ReturnType<typeof clientWith>,
  run: (args: unknown) => Promise<unknown>,
  operation = 'update',
) => {
  const at =
    (index: number) =>
    (next: unknown): Promise<unknown> => {
      const callback = client.callbacks[index];
      return callback === undefined
        ? run(next)
        : callback({ model: 'User', operation, args: next, query: at(index + 1) });
    };
  return checkpoints.checkedQuery({ model: 'User', operation, query: at(0) }, client.innermost);
};

/** Continues a `User.update` through `client` as the audit hook does */
const write = (
  client: ReturnType<typeof clientWith>,
  args: unknown,
  run: (args: unknown) => Promise<unknown>,
  operation = 'update',
) => checkedWrite(client, run, operation).query(args);

const rejectionOf = async (pending: Promise<unknown>): Promise<AuditExtensionContinuationError> => {
  const error: unknown = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AuditExtensionContinuationError);
  if (!(error instanceof AuditExtensionContinuationError)) {
    throw new Error('the write was not rejected');
  }
  return error;
};

const args = { where: { id: 'u1' }, data: { email: 'a' } };

const withPost = { where: { id: 'u1' }, data: { email: 'a', posts: { create: { title: 'added' } } } };

describe('createExtensionCheckpoints', () => {
  describe('checkedQuery', () => {
    it('continues the write with the query the audit continues with for a client with no checkpoint', async () => {
      const { sent, run } = database();

      const result = await checkpoints
        .checkedQuery({ model: 'User', operation: 'update', query: run }, undefined)
        .query(args);

      expect(result).toEqual({ id: 'u1' });
      expect(sent).toEqual([args]);
    });

    it('runs a write whose values alone an extension changes, with the arguments the extension continued it with', async () => {
      const { sent, run } = database();
      const client = clientWith({
        name: 'encoding',
        callback: ({ query }) => query({ where: { id: 'u1' }, data: { email: 'encoded' } }),
      });

      expect(await write(client, args, run)).toEqual({ id: 'u1' });
      expect(sent).toEqual([{ where: { id: 'u1' }, data: { email: 'encoded' } }]);
    });

    it('rejects a nested write an extension adds before it reaches the database, naming the extension and the location', async () => {
      const { sent, run } = database();
      const client = clientWith({
        name: 'adds-post',
        callback: ({ query }) => query(withPost),
      });

      const error = await rejectionOf(write(client, args, run));

      expect(error).toMatchObject({
        extensionName: 'adds-post',
        modelName: 'User',
        operation: 'update',
        violation: { kind: 'structure', added: ['posts.create'], removed: [], changed: [] },
      });
      expect(error.message).toContain('posts.create');
      expect(sent).toEqual([]);
    });

    it('reads the arguments a checkpoint receives as Prisma sends them, a nested write behind a toJSON included, and sends those', async () => {
      const { sent, run } = database();
      const sentAs = (value: unknown) => ({ toJSON: () => value });
      const rejected = clientWith({
        name: 'adds-post-behind-toJSON',
        callback: ({ query }) => query({ where: { id: 'u1' }, data: { email: 'a', posts: sentAs({ create: {} }) } }),
      });
      const accepted = clientWith({
        name: 'encodes-behind-toJSON',
        callback: ({ query }) => query({ where: { id: 'u1' }, data: sentAs({ email: 'encoded' }) }),
      });

      expect((await rejectionOf(write(rejected, args, run))).violation).toMatchObject({ added: ['posts.create'] });
      await write(accepted, args, run);

      expect(sent).toEqual([{ where: { id: 'u1' }, data: { email: 'encoded' } }]);
    });

    it('lets a read and a raw query through a checkpoint unchecked, with no write continued', async () => {
      const [checkpoint] = clientWith({ callback: passingOn }).callbacks.slice(1);
      const query = async (received: unknown) => ({ received });

      expect(await checkpoint?.({ model: 'User', operation: 'findMany', args: { where: {} }, query })).toEqual({
        received: { where: {} },
      });
      expect(await checkpoint?.({ operation: '$queryRaw', args: ['SELECT 1'], query })).toEqual({
        received: ['SELECT 1'],
      });
    });

    it('rejects a model write that reaches a checkpoint without the continuation of the audit, before it runs', async () => {
      const [checkpoint] = clientWith({ callback: passingOn }).callbacks.slice(1);
      const { sent, run } = database();

      const error: unknown = await checkpoint?.({ model: 'User', operation: 'update', args, query: run }).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(AuditUnboundWriteError);
      expect(error).toMatchObject({ modelName: 'User', operation: 'update' });
      expect(sent).toEqual([]);
    });
  });

  describe('how an extension continues the write', () => {
    it('rejects a write an extension settles without continuing through query, naming the extension', async () => {
      const { sent, run } = database();
      const client = clientWith({ name: 'soft-delete', callback: async () => ({ id: 'u1', deletedAt: 'now' }) });

      const error = await rejectionOf(write(client, args, run));

      expect(error).toMatchObject({
        name: 'AuditExtensionContinuationError',
        extensionName: 'soft-delete',
        violation: { kind: 'not-continued' },
      });
      expect(error.message).toContain('createAuditClient');
      expect(sent).toEqual([]);
    });

    it('lets the failure of the write through as it is', async () => {
      const { run } = database(() => true);
      const client = clientWith({ name: 'passing-on', callback: passingOn });

      await expect(write(client, args, run)).rejects.toThrow('unique constraint failed');
    });

    it('runs a write again after a failed attempt', async () => {
      const { sent, run } = database((sentArgs) => JSON.stringify(sentArgs).includes('taken'));
      const client = clientWith({
        name: 'retrying',
        callback: async ({ args: received, query }) => {
          try {
            return await query({ where: { id: 'u1' }, data: { email: 'taken' } });
          } catch {
            return query(received);
          }
        },
      });

      expect(await write(client, args, run)).toEqual({ id: 'u1' });
      expect(sent).toEqual([{ where: { id: 'u1' }, data: { email: 'taken' } }, args]);
    });

    it('rejects a write whose failed attempt an extension swallows to return a result of its own', async () => {
      const { run } = database(() => true);
      const client = clientWith({
        name: 'swallowing',
        callback: async ({ args: received, query }) => query(received).catch(() => ({ id: 'u1' })),
      });

      expect(await rejectionOf(write(client, args, run))).toMatchObject({
        extensionName: 'swallowing',
        violation: { kind: 'not-continued' },
      });
    });

    it('rejects a second call to query after a successful one, before it reaches the database', async () => {
      const { sent, run } = database();
      const client = clientWith({
        name: 'twice',
        callback: async ({ args: received, query }) => {
          await query(received);
          return query(received);
        },
      });

      expect(await rejectionOf(write(client, args, run))).toMatchObject({
        extensionName: 'twice',
        violation: { kind: 'continued-twice' },
      });
      expect(sent).toEqual([args]);
    });

    it('rejects the second of two concurrent calls to query before it reaches the database', async () => {
      const { sent, run } = database();
      const client = clientWith({
        name: 'concurrent',
        callback: async ({ args: received, query }) => {
          const [first] = await Promise.all([query(received), query(received)]);
          return first;
        },
      });

      expect(await rejectionOf(write(client, args, run))).toMatchObject({
        extensionName: 'concurrent',
        violation: { kind: 'continued-twice' },
      });
      expect(sent).toEqual([args]);
    });

    it('rejects a call to query once the write the audit continued has settled', async () => {
      const { sent, run } = database();
      let late: Promise<unknown> | undefined;
      const client = clientWith({
        name: 'late',
        callback: async ({ args: received, query }) => {
          late = new Promise((resolve) => {
            setTimeout(() => resolve(query(received).catch((reason: unknown) => reason)), 0);
          });
          return { id: 'u1' };
        },
      });

      expect((await rejectionOf(write(client, args, run))).violation).toEqual({ kind: 'not-continued' });
      const lateError = await late;

      expect(lateError).toBeInstanceOf(AuditExtensionContinuationError);
      expect(lateError).toMatchObject({ extensionName: 'late', violation: { kind: 'continued-after-settling' } });
      expect(sent).toEqual([]);
    });
  });

  describe('the extension a rejection names, in a chain of extensions', () => {
    it.each([
      {
        fault: 'the second replaces the write',
        first: passingOn,
        second: async () => ({ id: 'u1' }),
        expected: { extensionName: 'second', violation: { kind: 'not-continued' } },
      },
      {
        fault: 'the first replaces the write',
        first: async () => ({ id: 'u1' }),
        second: passingOn,
        expected: { extensionName: 'first', violation: { kind: 'not-continued' } },
      },
      {
        fault: 'the first adds a nested write',
        first: (({ query }) => query(withPost)) satisfies Callback,
        second: passingOn,
        expected: { extensionName: 'first', violation: { kind: 'structure' } },
      },
      {
        fault: 'the second adds a nested write',
        first: passingOn,
        second: (({ query }) => query(withPost)) satisfies Callback,
        expected: { extensionName: 'second', violation: { kind: 'structure' } },
      },
      {
        fault: 'the first calls query a second time',
        first: (async ({ args: received, query }) => {
          await query(received);
          return query(received);
        }) satisfies Callback,
        second: passingOn,
        expected: { extensionName: 'first', violation: { kind: 'continued-twice' } },
      },
    ])('names the extension at fault when $fault', async ({ first, second, expected }) => {
      const { run } = database();
      const client = clientWith({ name: 'first', callback: first }, { name: 'second', callback: second });

      expect(await rejectionOf(write(client, args, run))).toMatchObject(expected);
    });

    it.each([
      { swallowing: 'first', expected: 'first' },
      { swallowing: 'second', expected: 'second' },
    ])(
      'names the $swallowing extension when it swallows a failed attempt the extensions after it let through',
      async ({ swallowing, expected }) => {
        const { run } = database(() => true);
        const swallows: Callback = async ({ args: received, query }) => query(received).catch(() => ({ id: 'u1' }));
        const client = clientWith(
          { name: 'first', callback: swallowing === 'first' ? swallows : passingOn },
          { name: 'second', callback: swallowing === 'second' ? swallows : passingOn },
        );

        expect(await rejectionOf(write(client, args, run))).toMatchObject({
          extensionName: expected,
          violation: { kind: 'not-continued' },
        });
      },
    );

    it('names no extension when the one at fault has no name', async () => {
      const { run } = database();
      const client = clientWith({ callback: async () => ({ id: 'u1' }) });

      const error = await rejectionOf(write(client, args, run));

      expect(error.extensionName).toBeUndefined();
      expect(error.message).toContain('a query extension applied after the audit');
    });
  });
  describe('reachedDatabase', () => {
    it('is false until the innermost checkpoint runs the write, true while it runs and after it is written', async () => {
      let observe: (() => boolean) | undefined;
      const seen: boolean[] = [];
      const client = clientWith({
        name: 'observer',
        callback: async ({ args: received, query }) => {
          seen.push(observe?.() ?? false);
          return query(received);
        },
      });
      const checked = checkedWrite(client, async () => {
        seen.push(checked.reachedDatabase());
        return { id: 'u1' };
      });
      observe = checked.reachedDatabase;

      expect(checked.reachedDatabase()).toBe(false);
      await checked.query(args);

      expect(seen).toEqual([false, true]);
      expect(checked.reachedDatabase()).toBe(true);
    });

    it('is false when an extension settles without continuing the write', async () => {
      const client = clientWith({ name: 'fabricating', callback: async () => ({ id: 'u1' }) });
      const checked = checkedWrite(client, database().run);

      await rejectionOf(checked.query(args));

      expect(checked.reachedDatabase()).toBe(false);
    });

    it('is false after a failed attempt alone', async () => {
      const { run } = database(() => true);
      const checked = checkedWrite(clientWith({ callback: passingOn }), run);

      await expect(checked.query(args)).rejects.toThrow('unique constraint failed');

      expect(checked.reachedDatabase()).toBe(false);
    });

    it('stays true after a successful attempt when a later call to query is rejected', async () => {
      const { run } = database();
      const client = clientWith({
        name: 'twice',
        callback: async ({ args: received, query }) => {
          await query(received);
          return query(received);
        },
      });
      const checked = checkedWrite(client, run);

      await rejectionOf(checked.query(args));

      expect(checked.reachedDatabase()).toBe(true);
    });

    it('is true when an extension follows a failed attempt with a successful one', async () => {
      let attempts = 0;
      const { run } = database(() => ++attempts === 1);
      const client = clientWith({
        callback: async ({ args: received, query }) => {
          await query(received).catch(() => undefined);
          return query(received);
        },
      });
      const checked = checkedWrite(client, run);

      await checked.query(args);

      expect(checked.reachedDatabase()).toBe(true);
    });

    it('is true when an extension throws after its call to query succeeded', async () => {
      const client = clientWith({
        callback: async ({ args: received, query }) => {
          await query(received);
          throw new Error('extension failed');
        },
      });
      const checked = checkedWrite(client, database().run);

      await expect(checked.query(args)).rejects.toThrow('extension failed');

      expect(checked.reachedDatabase()).toBe(true);
    });

    it('is true while the write still runs when an extension settles without waiting for it', async () => {
      let release: (() => void) | undefined;
      const running = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: Promise<unknown> | undefined;
      const client = clientWith({
        name: 'impatient',
        callback: async ({ args: received, query }) => {
          started = query(received);
          return { id: 'u1' };
        },
      });
      const checked = checkedWrite(client, async () => {
        await running;
        return { id: 'u1' };
      });

      const error = await rejectionOf(checked.query(args));

      expect(error.violation).toEqual({ kind: 'not-continued' });
      expect(checked.reachedDatabase()).toBe(true);
      release?.();
      await started;
    });

    it('is true once write.query runs for a client with no checkpoint, and false before', async () => {
      let observed: boolean | undefined;
      const checked = checkpoints.checkedQuery(
        {
          model: 'User',
          operation: 'update',
          query: async () => {
            observed = checked.reachedDatabase();
            return { id: 'u1' };
          },
        },
        undefined,
      );

      expect(checked.reachedDatabase()).toBe(false);
      await checked.query(args);

      expect(observed).toBe(true);
      expect(checked.reachedDatabase()).toBe(true);
    });

    it('is false for a client with no checkpoint whose write failed', async () => {
      const checked = checkpoints.checkedQuery(
        { model: 'User', operation: 'update', query: database(() => true).run },
        undefined,
      );

      await expect(checked.query(args)).rejects.toThrow('unique constraint failed');

      expect(checked.reachedDatabase()).toBe(false);
    });

    it.each([
      { order: 'a written round and a failed one', fails: [false, true] },
      { order: 'a failed round and a written one', fails: [true, false] },
    ])(
      'stays true across calls of the checked query, as the rounds of a limited write make them, after $order',
      async ({ fails }) => {
        let call = 0;
        const { run } = database(() => fails[call++] === true);
        const checked = checkedWrite(clientWith({ callback: ({ args: received, query }) => query(received) }), run);

        await checked.query(args).catch(() => undefined);
        await checked.query(args).catch(() => undefined);

        expect(call).toBe(2);
        expect(checked.reachedDatabase()).toBe(true);
      },
    );

    it('turns true for a client with no checkpoint only once a later call of the checked query writes', async () => {
      let call = 0;
      const checked = checkpoints.checkedQuery(
        { model: 'User', operation: 'update', query: database(() => call++ === 0).run },
        undefined,
      );

      await expect(checked.query(args)).rejects.toThrow('unique constraint failed');
      expect(checked.reachedDatabase()).toBe(false);
      await checked.query(args);

      expect(checked.reachedDatabase()).toBe(true);
    });
  });
});
