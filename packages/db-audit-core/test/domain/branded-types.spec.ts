import { describe, expect, it } from 'vitest';
import {
  createActorId,
  createAggregateId,
  createEntityId,
  IdValidationError,
  unwrapId,
} from '../../src/domain/branded-types.js';

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

  describe('unwrapId', () => {
    it.each([
      ['ActorId', createActorId('user-123'), 'user-123'],
      ['EntityId', createEntityId('post-456'), 'post-456'],
      ['AggregateId', createAggregateId('order-789'), 'order-789'],
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
