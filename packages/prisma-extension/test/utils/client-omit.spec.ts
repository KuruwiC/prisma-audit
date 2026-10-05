/**
 * Unit tests for reading the fields a client-level `omit` hides, and for the reads that include them
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClientOmittedFields, withOmittedFieldsInFinds } from '../../src/utils/client-omit.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';

const scalar = (name: string) => ({ name, kind: 'scalar', type: 'String', isList: false });

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'User',
          fields: [
            { ...scalar('id'), isId: true },
            scalar('email'),
            scalar('password'),
            { name: 'posts', kind: 'object', type: 'Post', isList: true },
          ],
        },
        { name: 'Post', fields: [scalar('id'), scalar('content')] },
        { name: 'UuidV7Item', fields: [scalar('id'), scalar('token')] },
      ],
    },
  },
} as Parameters<typeof createSchemaMetadataFromDMMF>[0]);

describe('readClientOmittedFields', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    warn.mockClear();
  });

  it('reads the fields the client omits for each model, by its client property', () => {
    const client = { _globalOmit: { user: { password: true, email: false }, uuidV7Item: { token: true } } };

    const fields = readClientOmittedFields(client, schemaMetadata, '6.19.0');

    expect(fields.of('User')).toEqual(new Set(['password']));
    expect(fields.of('UuidV7Item')).toEqual(new Set(['token']));
    expect(fields.of('Post')).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads no field for a client created without omit', () => {
    const fields = readClientOmittedFields({ _globalOmit: undefined }, schemaMetadata, '6.19.0');

    expect(fields.of('User')).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads an inherited setting, as on a client derived by $extends', () => {
    const base = { _globalOmit: { user: { password: true } } };

    const fields = readClientOmittedFields(Object.create(base), schemaMetadata, '6.19.0');

    expect(fields.of('User')).toEqual(new Set(['password']));
  });

  it('leaves out an entry that is not a scalar field of the model', () => {
    const client = { _globalOmit: { user: { posts: true, unknown: true, password: true } } };

    expect(readClientOmittedFields(client, schemaMetadata, '6.19.0').of('User')).toEqual(new Set(['password']));
  });

  it('reads no field and warns once when a client that should carry the setting lacks it', () => {
    const fields = readClientOmittedFields({}, schemaMetadata, '6.19.0');

    expect(fields.of('User')).toEqual(new Set());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('client-level omit');
  });

  it.each([
    ['a string', 'password'],
    ['a model entry that is not an object', { user: true }],
    ['a field entry that is not a boolean', { user: { password: 'yes' } }],
  ])('reads no field and warns once when the setting is %s', (_label, value) => {
    const fields = readClientOmittedFields({ _globalOmit: value }, schemaMetadata, '7.9.1');

    expect(fields.of('User')).toEqual(new Set());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads no field and stays silent on a client older than client-level omit', () => {
    const fields = readClientOmittedFields({}, schemaMetadata, '5.15.2');

    expect(fields.of('User')).toEqual(new Set());
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('withOmittedFieldsInFinds', () => {
  const delegate = () => ({
    findUnique: vi.fn(async (args: unknown) => args),
    findMany: vi.fn(async (args: unknown) => args),
    updateManyAndReturn: vi.fn(async (args: unknown) => args),
  });

  it('returns the delegate itself when the client omits no field of the model', () => {
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
