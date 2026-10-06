import { describe, expect, it } from 'vitest';
import { extractEntityIdentity } from '../../src/utils/id-generation.js';
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
});
