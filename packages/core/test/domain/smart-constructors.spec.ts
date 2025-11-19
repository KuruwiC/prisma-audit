/**
 * Smart Constructors Tests
 */

import type { AuditLogInput } from '@kuruwic/prisma-audit-core';
import { createAuditLogData, failure, success } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';

describe('Smart Constructors', () => {
  describe('success', () => {
    it('should create a success Result', () => {
      const result = success({ value: 42 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ value: 42 });
      }
    });
  });

  describe('failure', () => {
    it('should create a failure Result', () => {
      const result = failure([{ field: 'test', message: 'error' }]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toEqual([{ field: 'test', message: 'error' }]);
      }
    });
  });

  describe('createAuditLogData', () => {
    const validInput: AuditLogInput = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: 'user-123',
      actorContext: { name: 'Alice' },
      entityCategory: 'model',
      entityType: 'Post',
      entityId: 'post-456',
      entityContext: { title: 'Hello World' },
      aggregateCategory: 'model',
      aggregateType: 'Post',
      aggregateId: 'post-456',
      aggregateContext: null,
      action: 'create',
      before: null,
      after: { id: 'post-456', title: 'Hello World' },
      changes: null,
      requestContext: { ip: '127.0.0.1' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
    };

    it('should create valid AuditLogData for valid input', () => {
      const result = createAuditLogData(validInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.actorCategory).toBe('model');
        expect(result.value.actorType).toBe('User');
        expect(result.value.actorId).toBe('user-123');
        expect(result.value.actorContext).toEqual({ name: 'Alice' });

        expect(result.value.entityCategory).toBe('model');
        expect(result.value.entityType).toBe('Post');
        expect(result.value.entityId).toBe('post-456');
        expect(result.value.entityContext).toEqual({ title: 'Hello World' });

        expect(result.value.aggregateCategory).toBe('model');
        expect(result.value.aggregateType).toBe('Post');
        expect(result.value.aggregateId).toBe('post-456');
        expect(result.value.aggregateContext).toBe(null);

        expect(result.value.action).toBe('create');
        expect(result.value.before).toBe(null);
        expect(result.value.after).toEqual({ id: 'post-456', title: 'Hello World' });
        expect(result.value.changes).toBe(null);

        expect(result.value.requestContext).toEqual({ ip: '127.0.0.1' });
        expect(result.value.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
      }
    });

    it.each([
      ['actorId', 'ActorId cannot be empty'],
      ['entityId', 'EntityId cannot be empty'],
      ['aggregateId', 'AggregateId cannot be empty'],
      ['actorCategory', 'Category cannot be empty'],
      ['actorType', 'Type cannot be empty'],
      ['entityCategory', 'Category cannot be empty'],
      ['entityType', 'Type cannot be empty'],
      ['aggregateCategory', 'Category cannot be empty'],
      ['aggregateType', 'Type cannot be empty'],
      ['action', 'cannot be empty'],
    ] as const)('should fail when %s is empty', (field, expectedMessage) => {
      const result = createAuditLogData({
        ...validInput,
        [field]: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.field).toBe(field);
        expect(result.errors[0]?.message).toMatch(new RegExp(expectedMessage));
      }
    });

    it('should fail when createdAt is invalid', () => {
      const result = createAuditLogData({
        ...validInput,
        createdAt: new Date('invalid'),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.field).toBe('createdAt');
        expect(result.errors[0]?.message).toMatch(/must be.*valid Date/);
      }
    });

    it('should collect multiple validation errors', () => {
      const result = createAuditLogData({
        ...validInput,
        actorId: '',
        entityId: '',
        aggregateId: '',
        actorCategory: '',
        entityType: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThanOrEqual(5);
        const errorFields = result.errors.map((e) => e.field);
        expect(errorFields).toContain('actorId');
        expect(errorFields).toContain('entityId');
        expect(errorFields).toContain('aggregateId');
        expect(errorFields).toContain('actorCategory');
        expect(errorFields).toContain('entityType');
      }
    });

    it('should handle whitespace-only strings as empty', () => {
      const result = createAuditLogData({
        ...validInput,
        actorId: '   ',
        actorCategory: '  ',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
        const errorFields = result.errors.map((e) => e.field);
        expect(errorFields).toContain('actorId');
        expect(errorFields).toContain('actorCategory');
      }
    });
  });
});
