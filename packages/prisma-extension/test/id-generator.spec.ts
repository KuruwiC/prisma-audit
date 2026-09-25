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

import type { SchemaMetadata } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import type { DMMFModel } from '../src/internal-types.js';
import {
  ensureIds,
  getIdFieldInfo,
  getIdGenerator,
  getPrimaryKeyConstraintOrThrow,
  ID_GENERATOR_FACTORIES,
} from '../src/utils/id-generation.js';
import { createSchemaMetadataFromDMMF } from '../src/utils/schema-metadata.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUID_V1_RE = /^c[a-z0-9]{24}$/;
const CUID2_RE = /^[a-z][a-z0-9]{23}$/;

/** Extract the 48-bit unix-ms timestamp prefix from a UUID v7 */
const uuidV7TimestampMs = (id: string): number => Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

/** Minimal SchemaMetadata whose `id` field carries the given DMMF-style default */
const metadataWithIdDefault = (defaultValue: unknown): SchemaMetadata => ({
  getUniqueConstraints: () => [],
  getRelationFields: () => [],
  getAllFields: () => [],
  getFieldMetadata: (_modelName, fieldName) =>
    fieldName === 'id'
      ? {
          name: 'id',
          type: 'String',
          kind: 'scalar',
          isRequired: true,
          isUnique: false,
          isId: true,
          isList: false,
          hasDefaultValue: defaultValue !== undefined,
          default: defaultValue,
        }
      : undefined,
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

  it('generates unique values', () => {
    const generator = ID_GENERATOR_FACTORIES.uuid?.([7]);
    const ids = new Set(Array.from({ length: 1000 }, () => generator?.()));
    expect(ids.size).toBe(1000);
  });
});

describe('cuid v1 generation', () => {
  it('matches the Prisma cuid() format (25 chars, leading "c")', () => {
    const id = ID_GENERATOR_FACTORIES.cuid?.([1])?.() as string;
    expect(id).toHaveLength(25);
    expect(id).toMatch(CUID_V1_RE);
  });

  it('generates unique values', () => {
    const generator = ID_GENERATOR_FACTORIES.cuid?.([1]);
    const ids = new Set(Array.from({ length: 1000 }, () => generator?.()));
    expect(ids.size).toBe(1000);
  });
});

describe('getIdGenerator (string expression route)', () => {
  it('parses argument-less expressions', () => {
    expect(getIdGenerator('cuid()')?.()).toMatch(CUID_V1_RE);
    expect(getIdGenerator('cuid2()')?.()).toMatch(CUID2_RE);
    expect(getIdGenerator('uuid()')?.()).toMatch(UUID_V4_RE);
  });

  it('parses versioned expressions', () => {
    expect(getIdGenerator('uuid(4)')?.()).toMatch(UUID_V4_RE);
    expect(getIdGenerator('uuid(7)')?.()).toMatch(UUID_V7_RE);
    expect(getIdGenerator('cuid(1)')?.()).toMatch(CUID_V1_RE);
    expect(getIdGenerator('cuid(2)')?.()).toMatch(CUID2_RE);
  });

  it('returns undefined for unknown versions instead of falling back', () => {
    expect(getIdGenerator('uuid(8)')).toBeUndefined();
    expect(getIdGenerator('cuid(3)')).toBeUndefined();
  });

  it('returns undefined for unsupported or malformed expressions', () => {
    expect(getIdGenerator('autoincrement()')).toBeUndefined();
    expect(getIdGenerator('dbgenerated("uuid_generate_v4()")')).toBeUndefined();
    expect(getIdGenerator('invalid')).toBeUndefined();
    expect(getIdGenerator('cuid')).toBeUndefined();
    expect(getIdGenerator('')).toBeUndefined();
  });
});

describe('getIdFieldInfo', () => {
  it('should return undefined if Prisma.dmmf is not available', () => {
    const Prisma = {};
    const info = getIdFieldInfo(createSchemaMetadataFromDMMF(Prisma), 'User', 'id');
    expect(info).toBeUndefined();
  });

  it('should return undefined if model is not found', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [{ name: 'User', fields: [] }],
        },
      },
    };
    const info = getIdFieldInfo(createSchemaMetadataFromDMMF(Prisma), 'NonExistent', 'id');
    expect(info).toBeUndefined();
  });

  it('should return undefined if field is not found', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [{ name: 'email', kind: 'scalar', type: 'String' }],
            },
          ],
        },
      },
    };
    const info = getIdFieldInfo(createSchemaMetadataFromDMMF(Prisma), 'User', 'id');
    expect(info).toBeUndefined();
  });

  it('should return field info with generator for cuid()', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [
                {
                  name: 'id',
                  kind: 'scalar',
                  type: 'String',
                  default: { name: 'cuid', args: [] },
                },
              ],
            },
          ],
        },
      },
    };
    const info = getIdFieldInfo(createSchemaMetadataFromDMMF(Prisma), 'User', 'id');
    expect(info).toBeDefined();
    expect(info?.name).toBe('id');
    expect(info?.hasDefault).toBe(true);
    expect(info?.defaultExpr).toBe('cuid()');
    expect(info?.generator).toBeDefined();
  });

  it('should preserve uuid version args from DMMF defaults (Prisma 6.x shape)', () => {
    // Prisma 6.x DMMF: @default(uuid(7)) -> { name: 'uuid', args: [7] }, @default(uuid()) -> args: [4]
    const createPrisma = (args: number[]) => ({
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [{ name: 'id', kind: 'scalar', type: 'String', default: { name: 'uuid', args } }],
            },
          ],
        },
      },
    });

    const v7 = getIdFieldInfo(createSchemaMetadataFromDMMF(createPrisma([7])), 'User', 'id');
    expect(v7?.defaultExpr).toBe('uuid(7)');
    expect(v7?.generator?.()).toMatch(UUID_V7_RE);

    const v4 = getIdFieldInfo(createSchemaMetadataFromDMMF(createPrisma([4])), 'User', 'id');
    expect(v4?.defaultExpr).toBe('uuid(4)');
    expect(v4?.generator?.()).toMatch(UUID_V4_RE);
  });

  it('should leave generator undefined for unknown uuid versions', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [{ name: 'id', kind: 'scalar', type: 'String', default: { name: 'uuid', args: [8] } }],
            },
          ],
        },
      },
    };
    const info = getIdFieldInfo(createSchemaMetadataFromDMMF(Prisma), 'User', 'id');
    expect(info?.defaultExpr).toBe('uuid(8)');
    expect(info?.generator).toBeUndefined();
  });

  it('should return field info without generator for autoincrement()', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [
                {
                  name: 'id',
                  kind: 'scalar',
                  type: 'Int',
                  default: { name: 'autoincrement', args: [] },
                },
              ],
            },
          ],
        },
      },
    };
    const info = getIdFieldInfo(createSchemaMetadataFromDMMF(Prisma), 'User', 'id');
    expect(info).toBeDefined();
    expect(info?.name).toBe('id');
    expect(info?.hasDefault).toBe(true);
    expect(info?.defaultExpr).toBe('autoincrement()');
    expect(info?.generator).toBeUndefined();
  });
});

describe('getIdFieldInfo default parsing', () => {
  it('preserves args from DMMF object defaults (uuid(7))', () => {
    const info = getIdFieldInfo(metadataWithIdDefault({ name: 'uuid', args: [7] }), 'Item');
    expect(info?.defaultExpr).toBe('uuid(7)');
    expect(info?.generator?.()).toMatch(UUID_V7_RE);
  });

  it('resolves DMMF object defaults with version 4 (uuid())', () => {
    const info = getIdFieldInfo(metadataWithIdDefault({ name: 'uuid', args: [4] }), 'Item');
    expect(info?.defaultExpr).toBe('uuid(4)');
    expect(info?.generator?.()).toMatch(UUID_V4_RE);
  });

  it('parses args from string defaults (uuid(7))', () => {
    const info = getIdFieldInfo(metadataWithIdDefault('uuid(7)'), 'Item');
    expect(info?.defaultExpr).toBe('uuid(7)');
    expect(info?.generator?.()).toMatch(UUID_V7_RE);
  });

  it('leaves generator undefined for unknown uuid versions', () => {
    const objectRoute = getIdFieldInfo(metadataWithIdDefault({ name: 'uuid', args: [8] }), 'Item');
    expect(objectRoute?.defaultExpr).toBe('uuid(8)');
    expect(objectRoute?.generator).toBeUndefined();

    const stringRoute = getIdFieldInfo(metadataWithIdDefault('uuid(8)'), 'Item');
    expect(stringRoute?.generator).toBeUndefined();
  });
});

describe('ensureIds', () => {
  const createMockPrisma = (defaultName: string) => ({
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              {
                name: 'id',
                kind: 'scalar',
                type: 'String',
                default: { name: defaultName, args: [] },
              },
            ],
          },
        ],
      },
    },
  });

  it('should return entities unchanged when all have IDs', () => {
    const Prisma = createMockPrisma('cuid');
    const entities = [
      { id: 'existing-1', email: 'user1@example.com' },
      { id: 'existing-2', email: 'user2@example.com' },
    ];
    const result = ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities);
    expect(result).toEqual(entities);
  });

  it('should generate unique IDs for all entities without IDs', () => {
    const Prisma = createMockPrisma('cuid');
    const entities = [{ email: 'user1@example.com' }, { email: 'user2@example.com' }];
    const result = ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities) as Array<{
      id: string;
      email: string;
    }>;

    expect(result).toHaveLength(2);
    const firstEntity = result[0];
    const secondEntity = result[1];
    expect(firstEntity).toBeDefined();
    expect(secondEntity).toBeDefined();
    expect(typeof firstEntity?.id).toBe('string');
    expect(typeof secondEntity?.id).toBe('string');
    expect(firstEntity?.id).not.toBe(secondEntity?.id);
  });

  it('should preserve existing IDs and generate only missing ones', () => {
    const Prisma = createMockPrisma('cuid');
    const entities = [{ id: 'existing', email: 'user1@example.com' }, { email: 'user2@example.com' }];
    const result = ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities) as Array<{
      id: string;
      email: string;
    }>;

    expect(result).toHaveLength(2);
    const firstEntity = result[0];
    const secondEntity = result[1];
    expect(firstEntity).toBeDefined();
    expect(secondEntity).toBeDefined();
    expect(firstEntity?.id).toBe('existing');
    expect(secondEntity?.id).toBeDefined();
    expect(secondEntity?.id).not.toBe('existing');
  });

  it('should throw error if no default is defined', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [{ name: 'id', kind: 'scalar', type: 'String' }],
            },
          ],
        },
      },
    };
    const entities = [{ email: 'user@example.com' }];
    expect(() => ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities)).toThrow(
      '[@prisma-audit] createMany requires pre-generated IDs',
    );
  });

  it('should throw error for unsupported default (autoincrement)', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [
                {
                  name: 'id',
                  kind: 'scalar',
                  type: 'Int',
                  default: { name: 'autoincrement', args: [] },
                },
              ],
            },
          ],
        },
      },
    };
    const entities = [{ email: 'user@example.com' }];
    expect(() => ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities)).toThrow(
      'unsupported default: autoincrement()',
    );
  });

  it('should inject UUID v7 IDs for @default(uuid(7)) models', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [{ name: 'id', kind: 'scalar', type: 'String', default: { name: 'uuid', args: [7] } }],
            },
          ],
        },
      },
    };
    const entities = [{ email: 'user1@example.com' }, { email: 'user2@example.com' }];
    const result = ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities) as Array<{
      id: string;
      email: string;
    }>;

    for (const entity of result) {
      expect(entity.id).toMatch(UUID_V7_RE);
    }
  });

  it('should throw for unknown uuid versions instead of silently injecting v4', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [{ name: 'id', kind: 'scalar', type: 'String', default: { name: 'uuid', args: [8] } }],
            },
          ],
        },
      },
    };
    const entities = [{ email: 'user@example.com' }];
    expect(() => ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities)).toThrow(
      'unsupported default: uuid(8)',
    );
  });

  it('should return empty array for empty input', () => {
    const Prisma = createMockPrisma('cuid');
    const result = ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', []);
    expect(result).toEqual([]);
  });

  it('should support custom ID field names', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [
                {
                  name: 'userId',
                  kind: 'scalar',
                  type: 'String',
                  default: { name: 'cuid', args: [] },
                },
              ],
            },
          ],
        },
      },
    };
    const entities = [{ email: 'user@example.com' }];
    const result = ensureIds(createSchemaMetadataFromDMMF(Prisma), 'User', entities, 'userId') as Array<{
      userId: string;
      email: string;
    }>;

    expect(result).toHaveLength(1);
    const firstEntity = result[0];
    expect(firstEntity).toBeDefined();
    expect(typeof firstEntity?.userId).toBe('string');
  });
});

describe('ensureIds format fidelity', () => {
  it('injects UUID v7 for @default(uuid(7)) models', () => {
    const result = ensureIds(metadataWithIdDefault({ name: 'uuid', args: [7] }), 'Item', [
      { label: 'a' },
      { label: 'b' },
    ]) as Array<{ id: string; label: string }>;

    for (const entity of result) {
      expect(entity.id).toMatch(UUID_V7_RE);
    }
    expect(result[0]?.id).not.toBe(result[1]?.id);
  });

  it('injects UUID v4 for @default(uuid()) models', () => {
    const result = ensureIds(metadataWithIdDefault({ name: 'uuid', args: [4] }), 'Item', [{ label: 'a' }]) as Array<{
      id: string;
      label: string;
    }>;
    expect(result[0]?.id).toMatch(UUID_V4_RE);
  });

  it('injects cuid v1 for @default(cuid()) models', () => {
    const result = ensureIds(metadataWithIdDefault({ name: 'cuid', args: [1] }), 'Item', [{ label: 'a' }]) as Array<{
      id: string;
      label: string;
    }>;
    expect(result[0]?.id).toMatch(CUID_V1_RE);
  });

  it('throws an unsupported-default error for unknown uuid versions instead of silently injecting v4', () => {
    expect(() => ensureIds(metadataWithIdDefault({ name: 'uuid', args: [8] }), 'Item', [{ label: 'a' }])).toThrow(
      'unsupported default: uuid(8)',
    );
  });
});

describe('getPrimaryKeyConstraintOrThrow', () => {
  const prismaWith = (models: DMMFModel[]) => ({ dmmf: { datamodel: { models } } });
  const scalar = (name: string, isId = false) => ({ name, kind: 'scalar', type: 'String', isId });

  it('returns the @id field', () => {
    const Prisma = prismaWith([{ name: 'User', fields: [scalar('id', true), scalar('email')] }]);

    expect(getPrimaryKeyConstraintOrThrow(Prisma, 'User')).toEqual({ type: 'primaryKey', fields: ['id'] });
  });

  it('returns a named @@id with its declared name', () => {
    const Prisma = prismaWith([
      {
        name: 'PostBookmark',
        fields: [scalar('postId'), scalar('userId')],
        primaryKey: { name: 'bookmarkKey', fields: ['postId', 'userId'] },
      },
    ]);

    expect(getPrimaryKeyConstraintOrThrow(Prisma, 'PostBookmark')).toEqual({
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: 'bookmarkKey',
    });
  });

  it('throws for a model without a primary key', () => {
    const Prisma = prismaWith([{ name: 'Setting', fields: [{ ...scalar('key'), isUnique: true }] }]);

    expect(() => getPrimaryKeyConstraintOrThrow(Prisma, 'Setting')).toThrow('Model "Setting" has no primary key');
  });

  it('throws for a model missing from DMMF', () => {
    const Prisma = prismaWith([{ name: 'User', fields: [scalar('id', true)] }]);

    expect(() => getPrimaryKeyConstraintOrThrow(Prisma, 'Unknown')).toThrow('Model "Unknown" not found in DMMF');
  });
});
