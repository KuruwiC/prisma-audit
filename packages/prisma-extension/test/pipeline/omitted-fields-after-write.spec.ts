/**
 * Unit tests for the read, after the write, of the omitted fields an entity audits
 */

import type { MutationEvent } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaBaseClient } from '../../src/internal-types.js';
import { readOmittedFieldsAfterWrite } from '../../src/pipeline/omitted-fields-after-write.js';
import { createAuditedOmittedFields } from '../../src/utils/audited-omitted-fields.js';
import { column, model, schemaMetadataOf } from '../support/audit-schema.js';

const schemaMetadata = schemaMetadataOf(
  model('User', [column('id', { isId: true }), column('name'), column('password')]),
  model('Post', [column('id', { isId: true }), column('title'), column('content')]),
  model('Tag', [column('id', { isId: true }), column('label')]),
  model('Legacy', [column('code'), column('secret')]),
  model('Device', [column('code', { isUnique: true, isRequired: true }), column('label'), column('secret')]),
);

const listed: Record<string, string[]> = {
  User: ['password'],
  Post: ['content'],
  Legacy: ['secret'],
  Device: ['secret'],
};
const auditedOmittedFields = createAuditedOmittedFields(
  (model) => (listed[model] ? { auditOmittedFields: listed[model] } : undefined),
  [],
);

const stored: Record<string, Array<Record<string, unknown>>> = {
  user: [
    { id: 'u1', password: 'hash-1' },
    { id: 'u2', password: 'hash-2' },
  ],
  post: [{ id: 'p1', content: 'Body' }],
};

const clientOf = () => {
  const findMany = (model: string) =>
    vi.fn(async (args: { where: { id: { in: string[] } }; select: Record<string, true> }) =>
      (stored[model] ?? [])
        .filter((row) => args.where.id.in.includes(row.id as string))
        .map((row) => Object.fromEntries(Object.keys(args.select).map((key) => [key, row[key]]))),
    );
  return {
    user: { findMany: findMany('user') },
    post: { findMany: findMany('post') },
    tag: { findMany: findMany('tag') },
  };
};

const eventOf = (
  model: string,
  action: MutationEvent['action'],
  after: Record<string, unknown> | undefined,
): MutationEvent => ({
  model,
  identity: String(after?.id ?? ''),
  action,
  before: { kind: 'none' },
  after,
  origin: { path: '', op: action },
});

const read = async (events: MutationEvent[], overrides: Record<string, unknown> = {}) => {
  const client = clientOf();
  const handle: PrismaBaseClient = Object.assign(Object.create(null), client, overrides);
  const completed = await readOmittedFieldsAfterWrite(events, handle, { schemaMetadata, auditedOmittedFields });
  return { completed, client };
};

describe('readOmittedFieldsAfterWrite', () => {
  it('reads the listed fields of the written rows of a model in one query, by primary key', async () => {
    const { completed, client } = await read([
      eventOf('User', 'create', { id: 'u1', name: 'Ada' }),
      eventOf('User', 'update', { id: 'u2', name: 'Bob' }),
    ]);

    expect(client.user.findMany).toHaveBeenCalledTimes(1);
    expect(client.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1', 'u2'] } },
      select: { id: true, password: true },
    });
    expect(completed.map((event) => event.after)).toEqual([
      { id: 'u1', name: 'Ada', password: 'hash-1' },
      { id: 'u2', name: 'Bob', password: 'hash-2' },
    ]);
  });

  it('reads once per model that lists fields', async () => {
    const { client } = await read([
      eventOf('User', 'create', { id: 'u1' }),
      eventOf('Post', 'create', { id: 'p1', title: 'T' }),
      eventOf('Tag', 'create', { id: 't1', label: 'L' }),
    ]);

    expect(client.user.findMany).toHaveBeenCalledTimes(1);
    expect(client.post.findMany).toHaveBeenCalledTimes(1);
    expect(client.tag.findMany).not.toHaveBeenCalled();
  });

  it('keeps a value the row already holds, and reads nothing for a row that holds every listed field', async () => {
    const holding = eventOf('User', 'update', { id: 'u1', password: 'from-the-write' });

    const { completed, client } = await read([holding]);

    expect(client.user.findMany).not.toHaveBeenCalled();
    expect(completed[0]).toBe(holding);
  });

  it('reads nothing for a delete, whose after state is not stored', async () => {
    const deleted = eventOf('User', 'delete', { id: 'u1' });

    const { completed, client } = await read([deleted]);

    expect(client.user.findMany).not.toHaveBeenCalled();
    expect(completed).toEqual([deleted]);
  });

  it('keeps a row the read does not find as it is', async () => {
    const gone = eventOf('User', 'update', { id: 'u9', name: 'Gone' });

    const { completed } = await read([gone]);

    expect(completed[0]?.after).toEqual({ id: 'u9', name: 'Gone' });
  });

  it('rejects when the delegate of a model that lists fields cannot findMany', async () => {
    await expect(read([eventOf('Post', 'create', { id: 'p1', title: 'T' })], { post: {} })).rejects.toThrow(
      '[@prisma-audit] Cannot read the omitted fields of Post: no findMany',
    );
  });

  it('reads the rows of a model without a primary key by its unique field on a required column', async () => {
    const findMany = vi.fn(async (args: { where: { code: { in: string[] } }; select: Record<string, true> }) =>
      args.where.code.in.map((code) => ({ code, secret: `secret of ${code}` })),
    );

    const { completed } = await read(
      [
        { ...eventOf('Device', 'create', { code: 'd1', label: 'One' }), identity: 'd1' },
        { ...eventOf('Device', 'update', { code: 'd2', label: 'Two' }), identity: 'd2' },
      ],
      { device: { findMany } },
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { code: { in: ['d1', 'd2'] } },
      select: { code: true, secret: true },
    });
    expect(completed.map((event) => event.after)).toEqual([
      { code: 'd1', label: 'One', secret: 'secret of d1' },
      { code: 'd2', label: 'Two', secret: 'secret of d2' },
    ]);
  });

  it('passes the rows of a model without a row key through, reading nothing for them', async () => {
    const legacy = eventOf('Legacy', 'create', { code: 'x' });
    const findMany = vi.fn();

    const { completed } = await read([legacy], { legacy: { findMany } });

    expect(findMany).not.toHaveBeenCalled();
    expect(completed).toEqual([legacy]);
  });
});
