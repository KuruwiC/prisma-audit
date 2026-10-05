/**
 * Unit tests for the omitted fields an entity audits, and for the audit's reads that include them
 */

import { defineEntity } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { createAuditedOmittedFields, withOmittedFieldsInFinds } from '../../src/utils/audited-omitted-fields.js';

describe('createAuditedOmittedFields', () => {
  const entities = {
    user: defineEntity({ type: 'User', excludeFields: ['updatedAt'], auditOmittedFields: ['password', 'updatedAt'] }),
    post: defineEntity({ type: 'Post', auditOmittedFields: ['content', 'createdAt'] }),
    comment: defineEntity({ type: 'Comment' }),
  };
  const fields = createAuditedOmittedFields(
    (model) => entities[model.toLowerCase() as keyof typeof entities],
    ['createdAt'],
  );

  it('lists the fields an entity audits, without the ones its own excludeFields names', () => {
    expect(fields.of('User')).toEqual(new Set(['password']));
  });

  it('leaves out the fields the global excludeFields names for an entity without its own list', () => {
    expect(fields.of('Post')).toEqual(new Set(['content']));
  });

  it('lists none for an entity without the option, or a model without an entity', () => {
    expect(fields.of('Comment')).toEqual(new Set());
    expect(fields.of('Tag')).toEqual(new Set());
  });
});

describe('withOmittedFieldsInFinds', () => {
  const delegate = () => ({
    findUnique: vi.fn(async (args: unknown) => args),
    findMany: vi.fn(async (args: unknown) => args),
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
