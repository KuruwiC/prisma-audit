import { describe, expect, it } from 'vitest';
import { safeStringify, serializeForAuditJson, UNHANDLED } from '../../src/utils/serialization.js';

describe('safeStringify', () => {
  it('should stringify BigInt values without throwing', () => {
    const obj = { id: 123n, name: 'test' };
    expect(() => safeStringify(obj)).not.toThrow();
    expect(safeStringify(obj)).toBe('{"id":"123","name":"test"}');
  });

  it('should stringify top-level BigInt', () => {
    expect(safeStringify(123n)).toBe('"123"');
  });

  it('should stringify nested BigInt in objects', () => {
    const obj = { user: { id: 999n, balance: 9007199254740991n } };
    const result = JSON.parse(safeStringify(obj) as string);
    expect(result.user.id).toBe('999');
    expect(result.user.balance).toBe('9007199254740991');
  });

  it('should stringify BigInt in arrays', () => {
    expect(safeStringify([1n, 2n, 3n])).toBe('["1","2","3"]');
  });

  it('should handle mixed types including BigInt', () => {
    const obj = {
      bigint: 42n,
      number: 42,
      string: '42',
      boolean: true,
      null: null,
      date: new Date('2025-01-01T00:00:00.000Z'),
    };
    const result = JSON.parse(safeStringify(obj) as string);
    expect(result.bigint).toBe('42');
    expect(result.number).toBe(42);
    expect(result.string).toBe('42');
    expect(result.boolean).toBe(true);
    expect(result.null).toBe(null);
    expect(result.date).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should handle values without BigInt identically to JSON.stringify', () => {
    const obj = { name: 'test', count: 5, nested: { active: true } };
    expect(safeStringify(obj)).toBe(JSON.stringify(obj));
  });

  it('should return undefined for top-level undefined', () => {
    expect(safeStringify(undefined)).toBeUndefined();
  });

  it('should return undefined for top-level function', () => {
    expect(safeStringify(() => {})).toBeUndefined();
  });
});

describe('serializeForAuditJson', () => {
  describe('BigInt handling', () => {
    it('should convert BigInt to string', () => {
      expect(serializeForAuditJson(123n)).toBe('123');
    });

    it('should convert large BigInt to string', () => {
      expect(serializeForAuditJson(9007199254740991n)).toBe('9007199254740991');
    });

    it('should convert BigInt in nested objects', () => {
      const obj = { user: { id: 1n, balance: 100n } };
      const result = serializeForAuditJson(obj) as Record<string, unknown>;
      const user = result.user as Record<string, unknown>;
      expect(user.id).toBe('1');
      expect(user.balance).toBe('100');
    });

    it('should convert BigInt in arrays', () => {
      const arr = [1n, 2n, 3n];
      expect(serializeForAuditJson(arr)).toEqual(['1', '2', '3']);
    });
  });

  describe('Date handling', () => {
    it('should convert Date to ISO string', () => {
      const date = new Date('2025-01-01T00:00:00.000Z');
      expect(serializeForAuditJson(date)).toBe('2025-01-01T00:00:00.000Z');
    });

    it('should convert Date in nested objects', () => {
      const obj = { createdAt: new Date('2025-06-15T12:00:00.000Z') };
      const result = serializeForAuditJson(obj) as Record<string, unknown>;
      expect(result.createdAt).toBe('2025-06-15T12:00:00.000Z');
    });
  });

  describe('primitive passthrough', () => {
    it('should return null as-is', () => {
      expect(serializeForAuditJson(null)).toBe(null);
    });

    it('should return undefined as-is', () => {
      expect(serializeForAuditJson(undefined)).toBe(undefined);
    });

    it('should return strings as-is', () => {
      expect(serializeForAuditJson('hello')).toBe('hello');
    });

    it('should return numbers as-is', () => {
      expect(serializeForAuditJson(42)).toBe(42);
    });

    it('should return booleans as-is', () => {
      expect(serializeForAuditJson(true)).toBe(true);
    });
  });

  describe('mixed types', () => {
    it('should handle objects with BigInt, Date, and primitives', () => {
      const obj = {
        id: 1n,
        name: 'test',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        count: 42,
        active: true,
        metadata: null,
      };
      const result = serializeForAuditJson(obj) as Record<string, unknown>;
      expect(result).toEqual({
        id: '1',
        name: 'test',
        createdAt: '2025-01-01T00:00:00.000Z',
        count: 42,
        active: true,
        metadata: null,
      });
    });

    it('should handle deeply nested structures', () => {
      const obj = {
        level1: {
          level2: {
            bigintField: 999n,
            dateField: new Date('2025-03-01T00:00:00.000Z'),
          },
        },
      };
      const result = serializeForAuditJson(obj) as Record<string, unknown>;
      const level1 = result.level1 as Record<string, unknown>;
      const level2 = level1.level2 as Record<string, unknown>;
      expect(level2.bigintField).toBe('999');
      expect(level2.dateField).toBe('2025-03-01T00:00:00.000Z');
    });

    it('should handle arrays of objects with mixed types', () => {
      const arr = [
        { id: 1n, date: new Date('2025-01-01T00:00:00.000Z') },
        { id: 2n, date: new Date('2025-01-02T00:00:00.000Z') },
      ];
      const result = serializeForAuditJson(arr) as Array<Record<string, unknown>>;
      expect(result).toEqual([
        { id: '1', date: '2025-01-01T00:00:00.000Z' },
        { id: '2', date: '2025-01-02T00:00:00.000Z' },
      ]);
    });
  });

  describe('idempotency', () => {
    it('should produce the same result when applied twice', () => {
      const obj = { id: 1n, createdAt: new Date('2025-01-01T00:00:00.000Z') };
      const first = serializeForAuditJson(obj);
      const second = serializeForAuditJson(first);
      expect(second).toEqual(first);
    });
  });

  describe('custom serializers', () => {
    it('should apply custom serializer before built-in conversions', () => {
      const customSerializer = (value: unknown) => {
        if (typeof value === 'bigint') return Number(value);
        return UNHANDLED;
      };
      expect(serializeForAuditJson(42n, [customSerializer])).toBe(42);
    });

    it('should fall through to built-in when custom returns UNHANDLED', () => {
      const noopSerializer = (_value: unknown) => UNHANDLED;
      expect(serializeForAuditJson(42n, [noopSerializer])).toBe('42');
    });

    it('should try multiple custom serializers in order', () => {
      const first = (_value: unknown) => UNHANDLED;
      const second = (value: unknown) => {
        if (typeof value === 'bigint') return `bigint:${value}`;
        return UNHANDLED;
      };
      expect(serializeForAuditJson(42n, [first, second])).toBe('bigint:42');
    });

    it('should apply custom serializers to nested values', () => {
      const bufferSerializer = (value: unknown) => {
        if (value instanceof Uint8Array) return `bytes:${value.length}`;
        return UNHANDLED;
      };
      const obj = { data: new Uint8Array([1, 2, 3]), id: 1n };
      const result = serializeForAuditJson(obj, [bufferSerializer]) as Record<string, unknown>;
      expect(result.data).toBe('bytes:3');
      expect(result.id).toBe('1');
    });

    it('should allow custom serializer to override Date handling', () => {
      const customDateSerializer = (value: unknown) => {
        if (value instanceof Date) return value.getTime();
        return UNHANDLED;
      };
      const date = new Date('2025-01-01T00:00:00.000Z');
      expect(serializeForAuditJson(date, [customDateSerializer])).toBe(1735689600000);
    });

    it('should NOT recursively serialize custom serializer return values', () => {
      const serializer = (value: unknown) => {
        if (typeof value === 'string' && value === 'trigger') {
          return { nested: 1n };
        }
        return UNHANDLED;
      };
      const result = serializeForAuditJson('trigger', [serializer]) as Record<string, unknown>;
      expect(result.nested).toBe(1n);
    });
  });
});
