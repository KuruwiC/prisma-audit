import { Decimal } from '@prisma/client/runtime/library';
import { describe, expect, it } from 'vitest';
import { extractEntityIdentity, sameKeyValue, serializeKeyValue } from '../../src/utils/id-generation.js';
import { UNRESOLVED_ENTITY_ID } from '../../src/utils/identity-key.js';

describe('extractEntityIdentity', () => {
  describe('single PK', () => {
    it('should extract single string PK', () => {
      expect(extractEntityIdentity({ id: 'abc' }, ['id'])).toBe('abc');
    });

    it('should extract single numeric PK', () => {
      expect(extractEntityIdentity({ id: 42 }, ['id'])).toBe('42');
    });

    it('should extract non-id field name', () => {
      expect(extractEntityIdentity({ uuid: 'x-y-z' }, ['uuid'])).toBe('x-y-z');
    });

    it('should return UNRESOLVED_ENTITY_ID when PK field is missing', () => {
      expect(extractEntityIdentity({ name: 'test' }, ['id'])).toBe(UNRESOLVED_ENTITY_ID);
    });

    it('should return UNRESOLVED_ENTITY_ID when PK field is null', () => {
      expect(extractEntityIdentity({ id: null }, ['id'])).toBe(UNRESOLVED_ENTITY_ID);
    });
  });

  describe('composite PK', () => {
    it('should serialize composite PK as JSON array', () => {
      const result = extractEntityIdentity({ tenantId: 'a', userId: '1' }, ['tenantId', 'userId']);
      expect(result).toBe(JSON.stringify(['a', '1']));
    });

    it('should return UNRESOLVED_ENTITY_ID when any composite PK field is missing', () => {
      expect(extractEntityIdentity({ tenantId: 'a' }, ['tenantId', 'userId'])).toBe(UNRESOLVED_ENTITY_ID);
    });

    it('should return UNRESOLVED_ENTITY_ID when any composite PK field is null', () => {
      expect(extractEntityIdentity({ tenantId: 'a', userId: null }, ['tenantId', 'userId'])).toBe(UNRESOLVED_ENTITY_ID);
    });
  });

  describe('values that are falsy but present', () => {
    it('resolves a single PK of 0 or an empty string', () => {
      expect(extractEntityIdentity({ id: 0 }, ['id'])).toBe('0');
      expect(extractEntityIdentity({ id: '' }, ['id'])).toBe('');
    });

    it('resolves a composite PK holding 0 or an empty string', () => {
      expect(extractEntityIdentity({ a: 0, b: '' }, ['a', 'b'])).toBe(JSON.stringify([0, '']));
    });
  });

  describe('composite PK values containing separators', () => {
    it('keeps composite keys whose values only differ in where the separator falls apart', () => {
      const first = extractEntityIdentity({ a: 'a:b', b: 'c' }, ['a', 'b']);
      const second = extractEntityIdentity({ a: 'a', b: 'b:c' }, ['a', 'b']);

      expect(first).toBe('["a:b","c"]');
      expect(second).toBe('["a","b:c"]');
      expect(first).not.toBe(second);
    });

    it('keeps the order of the key fields, not the order of the record', () => {
      expect(extractEntityIdentity({ b: 'y', a: 'x' }, ['a', 'b'])).toBe('["x","y"]');
    });
  });

  describe('BigInt safety', () => {
    it('should handle BigInt PK values', () => {
      const result = extractEntityIdentity({ id: BigInt(123) }, ['id']);
      expect(result).toBe('123');
    });

    it('should handle BigInt in composite PK', () => {
      const result = extractEntityIdentity({ a: BigInt(1), b: BigInt(2) }, ['a', 'b']);
      expect(result).toBe(JSON.stringify(['1', '2']));
    });
  });

  describe('single-field keys that are not strings or numbers', () => {
    it('names a Date by its ISO string, milliseconds included', () => {
      expect(extractEntityIdentity({ at: new Date('2026-01-02T03:04:05.678Z') }, ['at'])).toBe(
        '2026-01-02T03:04:05.678Z',
      );
    });

    it('keeps two Dates that differ by one millisecond apart', () => {
      const first = extractEntityIdentity({ at: new Date('2026-01-02T03:04:05.000Z') }, ['at']);
      const second = extractEntityIdentity({ at: new Date('2026-01-02T03:04:05.001Z') }, ['at']);
      expect(first).not.toBe(second);
    });

    it('names Bytes by their base64 form, the same for a Buffer and a Uint8Array', () => {
      const bytes = [0, 1, 2, 250, 255];
      const fromBuffer = extractEntityIdentity({ digest: Buffer.from(bytes) }, ['digest']);
      const fromUint8Array = extractEntityIdentity({ digest: new Uint8Array(bytes) }, ['digest']);
      expect(fromBuffer).toBe(fromUint8Array);
      expect([...Buffer.from(String(fromBuffer), 'base64')]).toEqual(bytes);
    });

    it('keeps Bytes that differ apart', () => {
      const first = extractEntityIdentity({ digest: Buffer.from([1, 2]) }, ['digest']);
      const second = extractEntityIdentity({ digest: Buffer.from([1, 3]) }, ['digest']);
      expect(first).not.toBe(second);
    });

    it('names a Decimal by its decimal string', () => {
      expect(extractEntityIdentity({ amount: new Decimal('12.50') }, ['amount'])).toBe('12.5');
    });

    it('names a Boolean by its text', () => {
      expect(extractEntityIdentity({ flag: false }, ['flag'])).toBe('false');
    });
  });

  describe('composite keys with elements that are not strings or numbers', () => {
    it('names a Date element by its ISO string', () => {
      const result = extractEntityIdentity({ tenant: 'a', at: new Date('2026-01-02T03:04:05.678Z') }, ['tenant', 'at']);
      expect(result).toBe(JSON.stringify(['a', '2026-01-02T03:04:05.678Z']));
    });

    it('keeps two Date elements that differ by one millisecond apart', () => {
      const first = extractEntityIdentity({ tenant: 'a', at: new Date(1000) }, ['tenant', 'at']);
      const second = extractEntityIdentity({ tenant: 'a', at: new Date(1001) }, ['tenant', 'at']);
      expect(first).not.toBe(second);
    });

    it('names a Bytes element by its base64 form', () => {
      const result = extractEntityIdentity({ tenant: 'a', digest: Buffer.from([0, 255]) }, ['tenant', 'digest']);
      expect(result).toBe(JSON.stringify(['a', Buffer.from([0, 255]).toString('base64')]));
    });

    it('names a Decimal element by its decimal string', () => {
      const result = extractEntityIdentity({ tenant: 'a', amount: new Decimal('1.25') }, ['tenant', 'amount']);
      expect(result).toBe(JSON.stringify(['a', '1.25']));
    });

    it('writes a number element as a JSON number, and a string and a BigInt element as JSON strings', () => {
      expect(extractEntityIdentity({ a: 7, b: '7', c: BigInt(7) }, ['a', 'b', 'c'])).toBe('[7,"7","7"]');
    });
  });
});

describe('serializeKeyValue', () => {
  it('writes a string, a number and a boolean as String does', () => {
    expect(serializeKeyValue('abc')).toBe('abc');
    expect(serializeKeyValue(42)).toBe('42');
    expect(serializeKeyValue(false)).toBe('false');
    expect(serializeKeyValue(null)).toBe('null');
  });

  it('writes a BigInt as its decimal string, a Date as its ISO string and Bytes as base64', () => {
    expect(serializeKeyValue(BigInt('9007199254740993'))).toBe('9007199254740993');
    expect(serializeKeyValue(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05.678Z');
    expect(serializeKeyValue(Buffer.from([0, 255]))).toBe('AP8=');
  });

  it('writes an invalid Date without throwing', () => {
    expect(serializeKeyValue(new Date(Number.NaN))).toBe('Invalid Date');
  });
});

describe('sameKeyValue', () => {
  it('tells two Dates that differ by one millisecond apart', () => {
    expect(sameKeyValue(new Date(1000), new Date(1000))).toBe(true);
    expect(sameKeyValue(new Date(1000), new Date(1001))).toBe(false);
  });

  it('treats null as null, and a number and a BigInt of the same value alike', () => {
    expect(sameKeyValue(null, null)).toBe(true);
    expect(sameKeyValue(7, BigInt(7))).toBe(true);
    expect(sameKeyValue(7, 8)).toBe(false);
  });

  it('never treats null or a missing value as equal to a string', () => {
    expect(sameKeyValue(null, 'null')).toBe(false);
    expect(sameKeyValue('null', null)).toBe(false);
    expect(sameKeyValue(undefined, 'undefined')).toBe(false);
    expect(sameKeyValue(undefined, null)).toBe(true);
  });

  it('treats an invalid Date as equal to an invalid Date only', () => {
    const invalid = new Date(Number.NaN);
    expect(sameKeyValue(invalid, 'Invalid Date')).toBe(false);
    expect(sameKeyValue('Invalid Date', invalid)).toBe(false);
    expect(sameKeyValue(invalid, new Date(0))).toBe(false);
    expect(sameKeyValue(invalid, new Date(Number.NaN))).toBe(true);
  });

  it('compares Bytes by content', () => {
    expect(sameKeyValue(Buffer.from([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameKeyValue(Buffer.from([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });
});
