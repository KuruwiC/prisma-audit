import { describe, expect, it } from 'vitest';
import { isBatchOperation, requiresBeforeState } from '../../src/utils/operation-classifier.js';

describe('operation-classifier', () => {
  describe('isBatchOperation', () => {
    it('classifies *Many and *AndReturn operations as batch', () => {
      expect(isBatchOperation('createMany')).toBe(true);
      expect(isBatchOperation('updateMany')).toBe(true);
      expect(isBatchOperation('deleteMany')).toBe(true);
      expect(isBatchOperation('createManyAndReturn')).toBe(true);
      expect(isBatchOperation('updateManyAndReturn')).toBe(true);
    });

    it('does not classify single-record operations as batch', () => {
      expect(isBatchOperation('create')).toBe(false);
      expect(isBatchOperation('update')).toBe(false);
      expect(isBatchOperation('upsert')).toBe(false);
      expect(isBatchOperation('delete')).toBe(false);
    });
  });

  describe('requiresBeforeState', () => {
    it('requires before state for update-like operations', () => {
      expect(requiresBeforeState('update')).toBe(true);
      expect(requiresBeforeState('upsert')).toBe(true);
      expect(requiresBeforeState('delete')).toBe(true);
      expect(requiresBeforeState('updateMany')).toBe(true);
      expect(requiresBeforeState('deleteMany')).toBe(true);
      expect(requiresBeforeState('updateManyAndReturn')).toBe(true);
    });

    it('does not require before state for create-like operations', () => {
      expect(requiresBeforeState('create')).toBe(false);
      expect(requiresBeforeState('createMany')).toBe(false);
      expect(requiresBeforeState('createManyAndReturn')).toBe(false);
    });
  });
});
