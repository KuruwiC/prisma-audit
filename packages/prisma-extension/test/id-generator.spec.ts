/**
 * ID Generator Unit Tests
 */

import { describe, expect, it } from 'vitest';
import { ensureIds, getIdFieldInfo, getIdGenerator, ID_GENERATOR_FACTORIES } from '../src/utils/id-generator.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ID_GENERATOR_FACTORIES', () => {
  it('should generate valid cuid identifiers', () => {
    const id = ID_GENERATOR_FACTORIES.cuid?.([1])?.();
    expect(typeof id).toBe('string');
    expect(id?.length).toBeGreaterThan(0);
  });

  it('should generate valid cuid2 identifiers', () => {
    const id = ID_GENERATOR_FACTORIES.cuid2?.([])?.();
    expect(typeof id).toBe('string');
    expect(id?.length).toBeGreaterThan(0);
  });

  it('should generate valid UUID identifiers', () => {
    expect(ID_GENERATOR_FACTORIES.uuid?.([4])?.()).toMatch(UUID_V4_RE);
    expect(ID_GENERATOR_FACTORIES.uuid?.([7])?.()).toMatch(UUID_V7_RE);
  });
});

describe('getIdGenerator', () => {
  it('should return generator functions for supported default expressions', () => {
    const cuidGen = getIdGenerator('cuid()');
    const uuidGen = getIdGenerator('uuid()');
    const uuid7Gen = getIdGenerator('uuid(7)');

    expect(cuidGen).toBeDefined();
    expect(typeof cuidGen?.()).toBe('string');

    expect(uuidGen?.()).toMatch(UUID_V4_RE);
    expect(uuid7Gen?.()).toMatch(UUID_V7_RE);
  });

  it('should return undefined for unsupported default expressions', () => {
    expect(getIdGenerator('autoincrement()')).toBeUndefined();
    expect(getIdGenerator('dbgenerated("uuid_generate_v4()")')).toBeUndefined();
    expect(getIdGenerator('invalid')).toBeUndefined();
    expect(getIdGenerator('cuid')).toBeUndefined();
    expect(getIdGenerator('')).toBeUndefined();
    expect(getIdGenerator('uuid(8)')).toBeUndefined();
  });
});

describe('getIdFieldInfo', () => {
  it('should return undefined if Prisma.dmmf is not available', () => {
    const Prisma = {};
    const info = getIdFieldInfo(Prisma, 'User', 'id');
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
    const info = getIdFieldInfo(Prisma, 'NonExistent', 'id');
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
    const info = getIdFieldInfo(Prisma, 'User', 'id');
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
    const info = getIdFieldInfo(Prisma, 'User', 'id');
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

    const v7 = getIdFieldInfo(createPrisma([7]), 'User', 'id');
    expect(v7?.defaultExpr).toBe('uuid(7)');
    expect(v7?.generator?.()).toMatch(UUID_V7_RE);

    const v4 = getIdFieldInfo(createPrisma([4]), 'User', 'id');
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
    const info = getIdFieldInfo(Prisma, 'User', 'id');
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
    const info = getIdFieldInfo(Prisma, 'User', 'id');
    expect(info).toBeDefined();
    expect(info?.name).toBe('id');
    expect(info?.hasDefault).toBe(true);
    expect(info?.defaultExpr).toBe('autoincrement()');
    expect(info?.generator).toBeUndefined();
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
    const result = ensureIds(Prisma, 'User', entities);
    expect(result).toEqual(entities);
  });

  it('should generate unique IDs for all entities without IDs', () => {
    const Prisma = createMockPrisma('cuid');
    const entities = [{ email: 'user1@example.com' }, { email: 'user2@example.com' }];
    const result = ensureIds(Prisma, 'User', entities) as Array<{ id: string; email: string }>;

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
    const result = ensureIds(Prisma, 'User', entities) as Array<{ id: string; email: string }>;

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
    expect(() => ensureIds(Prisma, 'User', entities)).toThrow('[@prisma-audit] createMany requires pre-generated IDs');
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
    expect(() => ensureIds(Prisma, 'User', entities)).toThrow('unsupported default: autoincrement()');
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
    const result = ensureIds(Prisma, 'User', entities) as Array<{ id: string; email: string }>;

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
    expect(() => ensureIds(Prisma, 'User', entities)).toThrow('unsupported default: uuid(8)');
  });

  it('should return empty array for empty input', () => {
    const Prisma = createMockPrisma('cuid');
    const result = ensureIds(Prisma, 'User', []);
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
    const result = ensureIds(Prisma, 'User', entities, 'userId') as Array<{ userId: string; email: string }>;

    expect(result).toHaveLength(1);
    const firstEntity = result[0];
    expect(firstEntity).toBeDefined();
    expect(typeof firstEntity?.userId).toBe('string');
  });
});
