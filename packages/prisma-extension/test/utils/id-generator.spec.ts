/**
 * ID generation and primary-key utility tests
 *
 * Format expectations are grounded in what Prisma itself generates
 * (verified against Prisma 6.19 client output):
 * - cuid()  -> cuid v1:  25 chars, starts with 'c'
 * - cuid(2) -> cuid2:    24 chars
 * - uuid()  -> UUID v4
 * - uuid(7) -> UUID v7 (48-bit unix-ms timestamp prefix)
 */

import { describe, expect, it } from 'vitest';
import type { FieldDefault, SchemaMetadata } from '../../src/schema/types.js';
import {
  buildEntityMap,
  buildKeyWhereClause,
  ensureIds,
  getIdFieldInfo,
  getRowKeyFields,
  ID_GENERATOR_FACTORIES,
  primaryKeyOf,
  rowKeyFieldsOf,
} from '../../src/utils/id-generation.js';
import { UNRESOLVED_ENTITY_ID } from '../../src/utils/identity-key.js';
import { column, model, schemaMetadataOf } from '../support/audit-schema.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUID_V1_RE = /^c[a-z0-9]{24}$/;
const CUID2_RE = /^[a-z][a-z0-9]{23}$/;

/** Extract the 48-bit unix-ms timestamp prefix from a UUID v7 */
const uuidV7TimestampMs = (id: string): number => Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

const metadataWithIdDefault = (defaultFunction: FieldDefault): SchemaMetadata =>
  schemaMetadataOf(
    model('Item', [column('id', { isId: true, isRequired: true, hasDefaultValue: true, default: defaultFunction })]),
  );

/** Schema metadata of a model `Item` whose `id` has a literal default, such as `@default("uuid(7)")` */
const metadataWithLiteralIdDefault = (): SchemaMetadata =>
  schemaMetadataOf(model('Item', [column('id', { isId: true, isRequired: true, hasDefaultValue: true })]));

const metadataWithoutIdDefault = (): SchemaMetadata =>
  schemaMetadataOf(model('User', [column('id', { isId: true, isRequired: true })]));

const metadataFailingWith = (error: Error): SchemaMetadata => ({
  ...metadataWithoutIdDefault(),
  getFieldMetadata: () => {
    throw error;
  },
});

describe('ID_GENERATOR_FACTORIES', () => {
  it('uuid factory returns v4 for no args / arg 4, v7 for arg 7, undefined otherwise', () => {
    expect(ID_GENERATOR_FACTORIES.uuid?.([])?.()).toMatch(UUID_V4_RE);
    expect(ID_GENERATOR_FACTORIES.uuid?.([4])?.()).toMatch(UUID_V4_RE);
    expect(ID_GENERATOR_FACTORIES.uuid?.([7])?.()).toMatch(UUID_V7_RE);
    expect(ID_GENERATOR_FACTORIES.uuid?.([8])).toBeUndefined();
  });

  it('cuid factory returns cuid v1 for no args / arg 1, cuid2 for arg 2, undefined otherwise', () => {
    expect(ID_GENERATOR_FACTORIES.cuid?.([])?.()).toMatch(CUID_V1_RE);
    expect(ID_GENERATOR_FACTORIES.cuid?.([1])?.()).toMatch(CUID_V1_RE);
    expect(ID_GENERATOR_FACTORIES.cuid?.([2])?.()).toMatch(CUID2_RE);
    expect(ID_GENERATOR_FACTORIES.cuid?.([3])).toBeUndefined();
  });
});

describe('UUID v7 generation', () => {
  it('embeds the current unix-ms timestamp in the first 48 bits', () => {
    const before = Date.now();
    const id = ID_GENERATOR_FACTORIES.uuid?.([7])?.() as string;
    const after = Date.now();

    const ts = uuidV7TimestampMs(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('getIdFieldInfo', () => {
  it('should return undefined if field is not found', () => {
    const metadata = schemaMetadataOf(model('User', [column('email')]));

    expect(getIdFieldInfo(metadata, 'User', 'id')).toBeUndefined();
  });

  it('throws naming a model the schema does not hold', () => {
    const metadata = schemaMetadataOf(model('User', []));

    expect(() => getIdFieldInfo(metadata, 'NonExistent', 'id')).toThrow(
      'Model "NonExistent" is not in the audit schema',
    );
  });

  it('lets an error reading the field metadata propagate', () => {
    const error = new Error('metadata unavailable');

    expect(() => getIdFieldInfo(metadataFailingWith(error), 'User', 'id')).toThrow(error);
  });

  it('should return field info with generator for cuid()', () => {
    const info = getIdFieldInfo(metadataWithIdDefault({ name: 'cuid', args: [] }), 'Item', 'id');
    expect(info).toBeDefined();
    expect(info?.name).toBe('id');
    expect(info?.hasDefault).toBe(true);
    expect(info?.defaultFunction).toBe('cuid()');
    expect(info?.generator).toBeDefined();
  });

  it('should preserve uuid version args from function defaults', () => {
    // @default(uuid(7)) -> { name: 'uuid', args: [7] }, @default(uuid()) -> args: [4]
    const v7 = getIdFieldInfo(metadataWithIdDefault({ name: 'uuid', args: [7] }), 'Item', 'id');
    expect(v7?.defaultFunction).toBe('uuid(7)');
    expect(v7?.generator?.()).toMatch(UUID_V7_RE);

    const v4 = getIdFieldInfo(metadataWithIdDefault({ name: 'uuid', args: [4] }), 'Item', 'id');
    expect(v4?.defaultFunction).toBe('uuid(4)');
    expect(v4?.generator?.()).toMatch(UUID_V4_RE);
  });

  it.each<[string, FieldDefault]>([
    ['cuid()', { name: 'cuid', args: [] }],
    ['cuid(2)', { name: 'cuid', args: [2] }],
    ['uuid()', { name: 'uuid', args: [4] }],
    ['uuid(7)', { name: 'uuid', args: [7] }],
  ])('%s yields a new id on every call', (_label, defaultFunction) => {
    const generate = getIdFieldInfo(metadataWithIdDefault(defaultFunction), 'Item', 'id')?.generator;

    expect(generate?.()).not.toBe(generate?.());
  });

  it('should return field info without generator for autoincrement()', () => {
    const info = getIdFieldInfo(metadataWithIdDefault({ name: 'autoincrement', args: [] }), 'Item', 'id');
    expect(info).toBeDefined();
    expect(info?.name).toBe('id');
    expect(info?.hasDefault).toBe(true);
    expect(info?.defaultFunction).toBe('autoincrement()');
    expect(info?.generator).toBeUndefined();
  });

  it('gives a literal default no generator, even one that reads like a generator call', () => {
    const info = getIdFieldInfo(metadataWithLiteralIdDefault(), 'Item', 'id');

    expect(info).toEqual({ name: 'id', hasDefault: true });
  });

  it('leaves generator undefined for unknown uuid versions', () => {
    const info = getIdFieldInfo(metadataWithIdDefault({ name: 'uuid', args: [8] }), 'Item', 'id');
    expect(info?.defaultFunction).toBe('uuid(8)');
    expect(info?.generator).toBeUndefined();
  });
});

describe('ensureIds', () => {
  const userWithIdDefault = (name: string) =>
    schemaMetadataOf(model('User', [column('id', { isId: true, hasDefaultValue: true, default: { name, args: [] } })]));

  it('should return entities unchanged when all have IDs', () => {
    const entities = [
      { id: 'existing-1', email: 'user1@example.com' },
      { id: 'existing-2', email: 'user2@example.com' },
    ];
    const result = ensureIds(userWithIdDefault('cuid'), 'User', entities, ['id']);
    expect(result).toEqual(entities);
  });

  it('should generate unique IDs for all entities without IDs', () => {
    const entities = [{ email: 'user1@example.com' }, { email: 'user2@example.com' }];
    const result = ensureIds(userWithIdDefault('cuid'), 'User', entities, ['id']) as Array<{
      id: string;
      email: string;
    }>;

    expect(result).toHaveLength(2);
    const firstEntity = result[0];
    const secondEntity = result[1];
    expect(firstEntity).toBeDefined();
    expect(secondEntity).toBeDefined();
    expect(firstEntity?.id).toMatch(CUID_V1_RE);
    expect(secondEntity?.id).toMatch(CUID_V1_RE);
    expect(firstEntity?.id).not.toBe(secondEntity?.id);
  });

  it('should preserve existing IDs and generate only missing ones', () => {
    const entities = [{ id: 'existing', email: 'user1@example.com' }, { email: 'user2@example.com' }];
    const result = ensureIds(userWithIdDefault('cuid'), 'User', entities, ['id']) as Array<{
      id: string;
      email: string;
    }>;

    expect(result).toHaveLength(2);
    const firstEntity = result[0];
    const secondEntity = result[1];
    expect(firstEntity).toBeDefined();
    expect(secondEntity).toBeDefined();
    expect(firstEntity?.id).toBe('existing');
    expect(secondEntity?.id).toMatch(CUID_V1_RE);
  });

  it('should throw error if no default is defined', () => {
    const entities = [{ email: 'user@example.com' }];
    expect(() => ensureIds(metadataWithoutIdDefault(), 'User', entities, ['id'])).toThrow(
      '[@prisma-audit] createMany requires pre-generated IDs',
    );
  });

  it('lets an error reading the field metadata propagate', () => {
    const error = new Error('metadata unavailable');

    expect(() => ensureIds(metadataFailingWith(error), 'User', [{ email: 'user@example.com' }], ['id'])).toThrow(error);
  });

  it('should throw error for unsupported default (autoincrement)', () => {
    const entities = [{ email: 'user@example.com' }];
    expect(() => ensureIds(userWithIdDefault('autoincrement'), 'User', entities, ['id'])).toThrow(
      'unsupported default: autoincrement()',
    );
  });

  it('throws for a literal default, naming it as one', () => {
    expect(() => ensureIds(metadataWithLiteralIdDefault(), 'Item', [{ label: 'a' }], ['id'])).toThrow(
      '[@prisma-audit] createMany requires pre-generated IDs for model "Item". ' +
        'Field "id" has a literal default value, not a generator function. ' +
        'Supported defaults: cuid(), cuid(2), uuid(), uuid(4), uuid(7).',
    );
  });

  it('should return empty array for empty input', () => {
    const result = ensureIds(userWithIdDefault('cuid'), 'User', [], ['id']);
    expect(result).toEqual([]);
  });

  it('generates a single primary key whatever its name, and adds no `id`', () => {
    const metadata = schemaMetadataOf(
      model('User', [column('userId', { hasDefaultValue: true, default: { name: 'cuid', args: [] } })]),
    );
    const entities = [{ email: 'user@example.com' }];
    const result = ensureIds(metadata, 'User', entities, ['userId']) as Array<{
      userId: string;
      email: string;
    }>;

    expect(result).toHaveLength(1);
    const firstEntity = result[0];
    expect(firstEntity).toBeDefined();
    expect(firstEntity?.userId).toMatch(CUID_V1_RE);
    expect(firstEntity).not.toHaveProperty('id');
  });

  it('injects UUID v7 for @default(uuid(7)) models', () => {
    const result = ensureIds(
      metadataWithIdDefault({ name: 'uuid', args: [7] }),
      'Item',
      [{ label: 'a' }, { label: 'b' }],
      ['id'],
    ) as Array<{ id: string; label: string }>;

    for (const entity of result) {
      expect(entity.id).toMatch(UUID_V7_RE);
    }
    expect(result[0]?.id).not.toBe(result[1]?.id);
  });

  it('injects UUID v4 for @default(uuid()) models', () => {
    const result = ensureIds(
      metadataWithIdDefault({ name: 'uuid', args: [4] }),
      'Item',
      [{ label: 'a' }],
      ['id'],
    ) as Array<{
      id: string;
      label: string;
    }>;
    expect(result[0]?.id).toMatch(UUID_V4_RE);
  });

  it('injects cuid v1 for @default(cuid()) models', () => {
    const result = ensureIds(
      metadataWithIdDefault({ name: 'cuid', args: [1] }),
      'Item',
      [{ label: 'a' }],
      ['id'],
    ) as Array<{
      id: string;
      label: string;
    }>;
    expect(result[0]?.id).toMatch(CUID_V1_RE);
  });

  it('throws an unsupported-default error for unknown uuid versions instead of silently injecting v4', () => {
    expect(() =>
      ensureIds(metadataWithIdDefault({ name: 'uuid', args: [8] }), 'Item', [{ label: 'a' }], ['id']),
    ).toThrow('unsupported default: uuid(8)');
  });

  describe('composite primary key', () => {
    const likeField = (name: string, defaultFunction?: FieldDefault) =>
      column(name, defaultFunction ? { hasDefaultValue: true, default: defaultFunction } : {});
    const metadataForLike = (fields: ReturnType<typeof likeField>[]) => schemaMetadataOf(model('Like', fields));
    const pkFields = ['postId', 'userId'];

    it('returns rows that supply every key field unchanged, adding no `id`', () => {
      const rows = [
        { postId: 'p1', userId: 'u1', note: 'a' },
        { postId: 'p1', userId: 'u2', note: 'b' },
      ];
      const result = ensureIds(metadataForLike([likeField('postId'), likeField('userId')]), 'Like', rows, pkFields);
      expect(result).toEqual(rows);
    });

    it('generates only the key field the rows leave out that has a supported default', () => {
      const result = ensureIds(
        metadataForLike([likeField('postId'), likeField('userId', { name: 'uuid', args: [7] })]),
        'Like',
        [{ postId: 'p1' }, { postId: 'p2', userId: 'u-supplied' }],
        pkFields,
      );
      expect(result[0]?.postId).toBe('p1');
      expect(result[0]?.userId).toMatch(UUID_V7_RE);
      expect(result[1]).toEqual({ postId: 'p2', userId: 'u-supplied' });
      expect(result[0]).not.toHaveProperty('id');
    });

    it('throws naming the key field a row leaves out that has no default', () => {
      expect(() =>
        ensureIds(metadataForLike([likeField('postId'), likeField('userId')]), 'Like', [{ postId: 'p1' }], pkFields),
      ).toThrow('Field "userId" has no default directive');
    });
  });
});

describe('getRowKeyFields', () => {
  it('returns the primary key of a model that has one, ahead of its unique fields', () => {
    const metadata = schemaMetadataOf(
      model('User', [
        column('email', { isUnique: true, isRequired: true }),
        column('id', { isId: true, isRequired: true }),
      ]),
    );

    expect(getRowKeyFields(metadata, 'User')).toEqual(['id']);
  });

  it('returns every field of a composite primary key', () => {
    const metadata = schemaMetadataOf(
      model('PostLike', [column('postId', { isRequired: true }), column('userId', { isRequired: true })], {
        primaryKey: { name: null, fields: ['postId', 'userId'] },
      }),
    );

    expect(getRowKeyFields(metadata, 'PostLike')).toEqual(['postId', 'userId']);
  });

  it('returns the first unique field on a required column of a model without a primary key, passing over a nullable one', () => {
    const metadata = schemaMetadataOf(
      model('Device', [
        column('label', { isUnique: true }),
        column('serial', { isUnique: true, isRequired: true }),
        column('code', { isUnique: true, isRequired: true }),
      ]),
    );

    expect(getRowKeyFields(metadata, 'Device')).toEqual(['serial']);
  });

  it('returns a unique index whose fields are all required when the model has no primary key or such unique field', () => {
    const metadata = schemaMetadataOf(
      model('Setting', [column('scope', { isRequired: true }), column('key', { isRequired: true }), column('note')], {
        uniqueIndexes: [
          { name: null, fields: ['scope', 'note'] },
          { name: 'scope_key', fields: ['scope', 'key'] },
        ],
      }),
    );

    expect(getRowKeyFields(metadata, 'Setting')).toEqual(['scope', 'key']);
  });

  it('throws naming the model when it has no primary key and no unique constraint on required fields', () => {
    const metadata = schemaMetadataOf(model('Note', [column('label', { isUnique: true }), column('text')]));

    expect(() => getRowKeyFields(metadata, 'Note')).toThrow(
      '[@prisma-audit] Model "Note" has no primary key and no unique constraint on required fields: its rows cannot be identified for a batch audit.',
    );
  });

  it('throws naming a model the schema does not hold', () => {
    const metadata = schemaMetadataOf(model('User', [column('id', { isId: true, isRequired: true })]));

    expect(() => getRowKeyFields(metadata, 'Unknown')).toThrow('Model "Unknown" is not in the audit schema');
  });
});

describe('rowKeyFieldsOf', () => {
  it('returns the primary key ahead of a unique field', () => {
    const metadata = schemaMetadataOf(
      model('User', [
        column('email', { isUnique: true, isRequired: true }),
        column('id', { isId: true, isRequired: true }),
      ]),
    );

    expect(rowKeyFieldsOf(metadata, 'User')).toEqual(['id']);
  });

  it('returns the first unique field on a required column of a model without a primary key', () => {
    const metadata = schemaMetadataOf(
      model('Device', [column('label', { isUnique: true }), column('code', { isUnique: true, isRequired: true })]),
    );

    expect(rowKeyFieldsOf(metadata, 'Device')).toEqual(['code']);
  });

  it('returns undefined for a model with no primary key and no unique constraint on required fields', () => {
    const metadata = schemaMetadataOf(model('Note', [column('label', { isUnique: true }), column('text')]));

    expect(rowKeyFieldsOf(metadata, 'Note')).toBeUndefined();
  });
});

describe('primaryKeyOf', () => {
  it('picks the key fields of the row, in the order of the key', () => {
    const key = primaryKeyOf({ title: 'T', userId: 'u1', postId: 'p1' }, ['postId', 'userId']);

    expect(key).toEqual({ postId: 'p1', userId: 'u1' });
    expect(Object.keys(key)).toEqual(['postId', 'userId']);
  });

  it('reads a field the row lacks as undefined, keeping its entry', () => {
    const key = primaryKeyOf({ postId: 'p1' }, ['postId', 'userId']);

    expect(Object.keys(key)).toEqual(['postId', 'userId']);
    expect(key.userId).toBeUndefined();
  });
});

describe('buildEntityMap', () => {
  it('maps each row by its entity identity', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ];

    const map = buildEntityMap(rows, ['id']);

    expect([...map.keys()]).toEqual(['a', 'b']);
    expect(map.get('a')).toBe(rows[0]);
    expect(map.get('b')).toBe(rows[1]);
  });

  it('maps each row of a composite key by the JSON array of its values', () => {
    const row = { postId: 'p1', userId: 'u1' };

    expect(buildEntityMap([row], ['postId', 'userId']).get('["p1","u1"]')).toBe(row);
  });

  it('keeps the last of the rows that share an identity, and files a row without a key under the unresolved identity', () => {
    const keyless = { n: 3 };

    const map = buildEntityMap([{ id: 'a', n: 1 }, { id: 'a', n: 2 }, keyless], ['id']);

    expect(map.size).toBe(2);
    expect(map.get('a')).toEqual({ id: 'a', n: 2 });
    expect(map.get(UNRESOLVED_ENTITY_ID)).toBe(keyless);
  });

  it('is empty for no rows', () => {
    expect(buildEntityMap([], ['id']).size).toBe(0);
  });
});

describe('buildKeyWhereClause', () => {
  it('is null for no entities, so a caller can skip the query', () => {
    expect(buildKeyWhereClause(['id'], [])).toBeNull();
    expect(buildKeyWhereClause(['postId', 'userId'], [])).toBeNull();
  });

  it('names a single key with one in-list of the values, in the order of the entities', () => {
    expect(buildKeyWhereClause(['id'], [{ id: 'b', n: 1 }, { id: 'a' }])).toEqual({ id: { in: ['b', 'a'] } });
  });

  it('names a composite key with one OR branch per entity holding only the key fields', () => {
    expect(
      buildKeyWhereClause(
        ['postId', 'userId'],
        [
          { postId: 'p1', userId: 'u1', title: 'T' },
          { postId: 'p2', userId: 'u2' },
        ],
      ),
    ).toEqual({
      OR: [
        { postId: 'p1', userId: 'u1' },
        { postId: 'p2', userId: 'u2' },
      ],
    });
  });
});
