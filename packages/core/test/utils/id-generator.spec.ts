/**
 * ID Generator Unit Tests (core)
 *
 * Format expectations are grounded in what Prisma itself generates
 * (verified against Prisma 6.19 client output):
 * - cuid()  -> cuid v1:  25 chars, starts with 'c'
 * - cuid(2) -> cuid2:    24 chars
 * - uuid()  -> UUID v4
 * - uuid(7) -> UUID v7 (48-bit unix-ms timestamp prefix)
 */

import { describe, expect, it } from 'vitest';
import type { SchemaMetadata } from '../../src/interfaces/index.js';
import { ensureIds, getIdFieldInfo, getIdGenerator, ID_GENERATOR_FACTORIES } from '../../src/utils/id-generator.js';

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
