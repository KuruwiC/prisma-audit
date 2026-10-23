/**
 * Unit tests for the omitted fields an entity records, and for the audit's reads that include them
 */

import { defineEntity } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createAuditedOmittedFields,
  withOmittedFieldsInFinds,
  withRowKeyFields,
} from '../../src/utils/audited-omitted-fields.js';
import { column, model, schemaMetadataOf } from '../support/audit-schema.js';

describe('createAuditedOmittedFields', () => {
  const entities = {
    user: defineEntity({
      type: 'User',
      diffExcludeFields: ['updatedAt'],
      recordOmittedFields: ['password', 'updatedAt', 'createdAt'],
    }),
    label: defineEntity({ type: 'Label', diffExcludeFields: [], recordOmittedFields: ['createdAt'] }),
    post: defineEntity({ type: 'Post', recordOmittedFields: ['content', 'createdAt'] }),
    comment: defineEntity({ type: 'Comment' }),
  };
  const fields = createAuditedOmittedFields(
    (model) => entities[model.toLowerCase() as keyof typeof entities],
    ['createdAt'],
  );

  it('lists the fields an entity records, without the ones its own diffExcludeFields names in place of the global list', () => {
    expect(fields.of('User')).toEqual(new Set(['password', 'createdAt']));
  });

  it('lists every field an entity records when its diffExcludeFields is empty', () => {
    expect(fields.of('Label')).toEqual(new Set(['createdAt']));
  });

  it('leaves out the fields the global diffExcludeFields names for an entity without its own list', () => {
    expect(fields.of('Post')).toEqual(new Set(['content']));
  });

  it('lists none for an entity without the option, or a model without an entity', () => {
    expect(fields.of('Comment')).toEqual(new Set());
    expect(fields.of('Tag')).toEqual(new Set());
  });
});

describe('withRowKeyFields', () => {
  const schemaMetadata = schemaMetadataOf(
    model('User', [column('id', { isId: true }), column('password')]),
    model('Membership', [column('orgId', { isRequired: true }), column('userId', { isRequired: true })], {
      primaryKey: { name: null, fields: ['orgId', 'userId'] },
    }),
    model('Device', [column('serial', { isUnique: true, isRequired: true }), column('name')]),
    model('Note', [column('label', { isUnique: true }), column('text', { isRequired: true })]),
  );
  const audited = createAuditedOmittedFields(
    (model) => (model === 'User' ? defineEntity({ type: 'User', recordOmittedFields: ['password'] }) : undefined),
    [],
  );

  it('adds the row key of each model to the fields it audits, on a client that takes a query omit', () => {
    const fields = withRowKeyFields(audited, schemaMetadata, true);

    expect(fields.of('User')).toEqual(new Set(['password', 'id']));
    expect(fields.of('Membership')).toEqual(new Set(['orgId', 'userId']));
    expect(fields.of('Device')).toEqual(new Set(['serial']));
  });

  it('adds no field on a client that takes no query omit', () => {
    const fields = withRowKeyFields(audited, schemaMetadata, false);

    expect(fields.of('User')).toEqual(new Set(['password']));
    expect(fields.of('Device')).toEqual(new Set());
  });

  it('adds no field for a model with no row key, and does not fail for it', () => {
    const fields = withRowKeyFields(audited, schemaMetadata, true);

    expect(fields.of('Note')).toEqual(new Set());
  });
});

describe('withOmittedFieldsInFinds', () => {
  const delegate = () => ({
    findUnique: vi.fn(async (args: unknown) => args),
    findFirst: vi.fn(async (args: unknown) => args),
    findMany: vi.fn(async (args?: unknown) => args),
    updateManyAndReturn: vi.fn(async (args: unknown) => args),
  });

  it('returns the delegate itself when the model audits no omitted field', () => {
    const original = delegate();

    expect(withOmittedFieldsInFinds(original, new Set())).toBe(original);
  });

  it('reads the omitted fields in a find without select', async () => {
    const original = delegate();
    const reader = withOmittedFieldsInFinds(original, new Set(['password']));

    await reader.findUnique({ where: { id: 'u1' } });
    await reader.findMany({ where: { id: 'u1' }, include: { posts: true } });

    expect(original.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, omit: { password: false } });
    expect(original.findMany).toHaveBeenCalledWith({
      where: { id: 'u1' },
      include: { posts: true },
      omit: { password: false },
    });
  });

  it('reads the omitted fields in a findFirst without select', async () => {
    const original = delegate();
    const reader = withOmittedFieldsInFinds(original, new Set(['password']));

    await reader.findFirst({ where: { id: 'u1' } });

    expect(original.findFirst).toHaveBeenCalledWith({ where: { id: 'u1' }, omit: { password: false } });
  });

  it('passes a find called without arguments through as it is, so it reads no omitted field', async () => {
    const original = delegate();
    const reader = withOmittedFieldsInFinds(original, new Set(['password']));

    await reader.findMany();

    expect(original.findMany).toHaveBeenCalledTimes(1);
    expect(original.findMany.mock.calls[0]).toEqual([undefined]);
  });

  it("merges the omitted fields into the find's own omit, the find's entry winning for a field both name", async () => {
    const original = delegate();
    const reader = withOmittedFieldsInFinds(original, new Set(['password', 'token']));

    await reader.findMany({ where: { id: 'u1' }, omit: { password: true, bio: true } });

    expect(original.findMany).toHaveBeenCalledWith({
      where: { id: 'u1' },
      omit: { password: true, token: false, bio: true },
    });
  });

  it('leaves a find that names its columns with select as it is', async () => {
    const original = delegate();
    const reader = withOmittedFieldsInFinds(original, new Set(['password']));

    await reader.findMany({ where: { id: 'u1' }, select: { id: true } });

    expect(original.findMany).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { id: true } });
  });

  it('leaves the operations other than finds as they are', async () => {
    const original = delegate();
    const reader = withOmittedFieldsInFinds(original, new Set(['password']));

    await reader.updateManyAndReturn({ where: { id: 'u1' } });

    expect(original.updateManyAndReturn).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});
