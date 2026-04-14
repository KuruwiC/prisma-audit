import { describe, expect, it } from 'vitest';

import { ENTITY_IDENTITY_DEFAULT, extractEntityIdentity } from '../src/utils/id-generator.js';

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

    it('should return default when PK field is missing', () => {
      expect(extractEntityIdentity({ name: 'test' }, ['id'])).toBe(ENTITY_IDENTITY_DEFAULT);
    });

    it('should return default when PK field is null', () => {
      expect(extractEntityIdentity({ id: null }, ['id'])).toBe(ENTITY_IDENTITY_DEFAULT);
    });
  });

  describe('composite PK', () => {
    it('should serialize composite PK as JSON array', () => {
      const result = extractEntityIdentity({ tenantId: 'a', userId: '1' }, ['tenantId', 'userId']);
      expect(result).toBe(JSON.stringify(['a', '1']));
    });

    it('should return default when any composite PK field is missing', () => {
      expect(extractEntityIdentity({ tenantId: 'a' }, ['tenantId', 'userId'])).toBe(ENTITY_IDENTITY_DEFAULT);
    });

    it('should return default when any composite PK field is null', () => {
      expect(extractEntityIdentity({ tenantId: 'a', userId: null }, ['tenantId', 'userId'])).toBe(
        ENTITY_IDENTITY_DEFAULT,
      );
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
