import { describe, expect, it } from 'vitest';
import { isBatchOperation, isSingleOperation, requiresBeforeState } from '../src/utils/operation-classifier.js';

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

  describe('isSingleOperation', () => {
    it('classifies single-record operations as single', () => {
      expect(isSingleOperation('create')).toBe(true);
      expect(isSingleOperation('update')).toBe(true);
      expect(isSingleOperation('upsert')).toBe(true);
      expect(isSingleOperation('delete')).toBe(true);
    });

    it('does not let batch *AndReturn operations flow into single handling', () => {
      expect(isSingleOperation('createManyAndReturn')).toBe(false);
      expect(isSingleOperation('updateManyAndReturn')).toBe(false);
      expect(isSingleOperation('createMany')).toBe(false);
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
