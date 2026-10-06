import { describe, expect, it } from 'vitest';
import { createDiffCalculator } from '../../src/utils/diff-calculator.js';

describe('createDiffCalculator', () => {
  const calculateDiff = createDiffCalculator(new Set<string>());

  describe('BigInt handling', () => {
    it('should detect no changes when BigInt values are equal', () => {
      const before = { id: '1', balance: 100n };
      const after = { id: '1', balance: 100n };
      expect(calculateDiff(before, after)).toBeNull();
    });

    it('should detect changes when BigInt values differ', () => {
      const before = { id: '1', balance: 100n };
      const after = { id: '1', balance: 200n };
      const result = calculateDiff(before, after);
      expect(result).toEqual({ balance: { old: 100n, new: 200n } });
    });

    it('should detect a change between BigInts that are the same Number', () => {
      expect(Number(9007199254740992n)).toBe(Number(9007199254740993n));

      const before = { id: '1', blockNumber: 9007199254740992n };
      const after = { id: '1', blockNumber: 9007199254740993n };
      const result = calculateDiff(before, after);
      expect(result).toEqual({
        blockNumber: { old: 9007199254740992n, new: 9007199254740993n },
      });
    });

    it('should handle BigInt fields alongside other types', () => {
      const before = { id: '1', balance: 100n, name: 'Alice', active: true };
      const after = { id: '1', balance: 200n, name: 'Alice', active: false };
      const result = calculateDiff(before, after);
      expect(result).toEqual({
        balance: { old: 100n, new: 200n },
        active: { old: true, new: false },
      });
    });

    it('should handle BigInt in nested objects', () => {
      const before = { id: '1', data: { amount: 100n } };
      const after = { id: '1', data: { amount: 200n } };
      const result = calculateDiff(before, after);
      expect(result).toEqual({
        data: { old: { amount: 100n }, new: { amount: 200n } },
      });
    });

    it('should handle BigInt in arrays', () => {
      const before = { id: '1', ids: [1n, 2n, 3n] };
      const after = { id: '1', ids: [1n, 2n, 4n] };
      const result = calculateDiff(before, after);
      expect(result).toEqual({
        ids: { old: [1n, 2n, 3n], new: [1n, 2n, 4n] },
      });
    });
  });

  describe('ignored fields with BigInt', () => {
    it('should ignore BigInt fields in the ignored set', () => {
      const diffWithIgnored = createDiffCalculator(new Set(['balance']));
      const before = { id: '1', balance: 100n, name: 'Alice' };
      const after = { id: '1', balance: 200n, name: 'Alice' };
      expect(diffWithIgnored(before, after)).toBeNull();
    });
  });

  describe('fields present in only one state', () => {
    it('should report a field only in before as changed to undefined', () => {
      const result = calculateDiff({ id: '1', nickname: 'Al' }, { id: '1' });
      expect(result).toStrictEqual({ nickname: { old: 'Al', new: undefined } });
    });

    it('should report a field only in after as changed from undefined', () => {
      const result = calculateDiff({ id: '1' }, { id: '1', nickname: 'Al' });
      expect(result).toStrictEqual({ nickname: { old: undefined, new: 'Al' } });
    });
  });

  describe('Date values', () => {
    it('should detect no change between distinct Date instances of the same time', () => {
      const before = { id: '1', publishedAt: new Date('2024-01-01T00:00:00Z') };
      const after = { id: '1', publishedAt: new Date('2024-01-01T00:00:00Z') };

      expect(calculateDiff(before, after)).toBeNull();
    });

    it('should detect a change between Dates of different times', () => {
      const old = new Date('2024-01-01T00:00:00Z');
      const next = new Date('2024-01-02T00:00:00Z');

      expect(calculateDiff({ id: '1', publishedAt: old }, { id: '1', publishedAt: next })).toEqual({
        publishedAt: { old, new: next },
      });
    });
  });

  describe('null/undefined states', () => {
    it('should return null when before is null', () => {
      expect(calculateDiff(null, { id: '1', balance: 100n })).toBeNull();
    });

    it('should return null when after is null', () => {
      expect(calculateDiff({ id: '1', balance: 100n }, null)).toBeNull();
    });

    it('should return null when before is undefined', () => {
      expect(calculateDiff(undefined, { id: '1', balance: 100n })).toBeNull();
    });

    it('should return null when after is undefined', () => {
      expect(calculateDiff({ id: '1', balance: 100n }, undefined)).toBeNull();
    });

    it('should return null when both states are undefined', () => {
      expect(calculateDiff(undefined, undefined)).toBeNull();
    });
  });
});
