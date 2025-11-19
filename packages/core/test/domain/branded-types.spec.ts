/**
 * Branded Types Tests
 */

import {
  type ActorId,
  createActorId,
  createAggregateId,
  createEntityId,
  createTraceId,
  IdValidationError,
  isActorId,
  isAggregateId,
  isEntityId,
  isTraceId,
  unwrapId,
} from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';

describe('Branded Types', () => {
  describe('createActorId', () => {
    it('should create a valid ActorId', () => {
      const id = createActorId('user-123');
      expect(id).toBe('user-123');
      expect(typeof id).toBe('string');
    });

    it('should throw IdValidationError for empty string', () => {
      expect(() => createActorId('')).toThrow(IdValidationError);
      expect(() => createActorId('')).toThrow(/ActorId cannot be empty/);
    });

    it('should throw IdValidationError for whitespace-only string', () => {
      expect(() => createActorId('   ')).toThrow(IdValidationError);
      expect(() => createActorId('   ')).toThrow(/ActorId cannot be empty/);
    });

    it('should preserve the error type and fields', () => {
      try {
        createActorId('');
      } catch (error) {
        expect(error).toBeInstanceOf(IdValidationError);
        if (error instanceof IdValidationError) {
          expect(error.idType).toBe('ActorId');
          expect(error.value).toBe('');
          expect(error.name).toBe('IdValidationError');
        }
      }
    });
  });

  describe.each([
    ['EntityId', createEntityId, 'post-456'],
    ['AggregateId', createAggregateId, 'order-789'],
    ['TraceId', createTraceId, 'trace-abc'],
  ] as const)('%s constructor', (typeName, createFn, validValue) => {
    it(`should create a valid ${typeName}`, () => {
      const id = createFn(validValue);
      expect(id).toBe(validValue);
      expect(typeof id).toBe('string');
    });

    it('should throw IdValidationError for empty or whitespace-only string', () => {
      expect(() => createFn('')).toThrow(IdValidationError);
      expect(() => createFn('')).toThrow(new RegExp(`${typeName} cannot be empty`));
      expect(() => createFn('   ')).toThrow(IdValidationError);
    });
  });

  describe('Type Guards', () => {
    describe('isActorId', () => {
      it('should return true for non-empty strings', () => {
        expect(isActorId('user-123')).toBe(true);
        expect(isActorId('a')).toBe(true);
      });

      it('should return false for empty strings', () => {
        expect(isActorId('')).toBe(false);
        expect(isActorId('   ')).toBe(false);
      });

      it('should return false for non-strings', () => {
        expect(isActorId(123)).toBe(false);
        expect(isActorId(null)).toBe(false);
        expect(isActorId(undefined)).toBe(false);
        expect(isActorId({})).toBe(false);
      });

      it('should work as type guard', () => {
        const value: unknown = 'user-123';
        if (isActorId(value)) {
          const typed: ActorId = value;
          expect(typed).toBe('user-123');
        }
      });
    });

    describe.each([
      ['isEntityId', isEntityId, 'post-456'],
      ['isAggregateId', isAggregateId, 'order-789'],
      ['isTraceId', isTraceId, 'trace-abc'],
    ] as const)('%s type guard', (_guardName, guardFn, validValue) => {
      it('should return true for non-empty strings', () => {
        expect(guardFn(validValue)).toBe(true);
      });

      it('should return false for empty/whitespace strings and non-strings', () => {
        expect(guardFn('')).toBe(false);
        expect(guardFn('   ')).toBe(false);
        expect(guardFn(123)).toBe(false);
        expect(guardFn(null)).toBe(false);
      });
    });
  });

  describe('unwrapId', () => {
    it.each([
      ['ActorId', createActorId('user-123'), 'user-123'],
      ['EntityId', createEntityId('post-456'), 'post-456'],
      ['AggregateId', createAggregateId('order-789'), 'order-789'],
      ['TraceId', createTraceId('trace-abc'), 'trace-abc'],
    ] as const)('should unwrap %s to string', (_, brandedId, expectedValue) => {
      const unwrapped = unwrapId(brandedId);
      expect(unwrapped).toBe(expectedValue);
      expect(typeof unwrapped).toBe('string');
    });
  });

  describe('Type Safety', () => {
    it('should prevent mixing different ID types (compile-time check)', () => {
      const actorId = createActorId('user-123');
      const entityId = createEntityId('post-456');

      expect(actorId).not.toBe(entityId);
    });
  });
});
