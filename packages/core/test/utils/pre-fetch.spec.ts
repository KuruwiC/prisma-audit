/**
 * Unit tests for pre-fetch logic (core)
 */

import { describe, expect, it } from 'vitest';
import type { SchemaMetadata, UniqueConstraint } from '../../src/interfaces/index.js';
import {
  executePreFetch,
  hasOrNot,
  matchesUniqueConstraint,
  parseWhereClause,
  preFetchBeforeState,
} from '../../src/utils/pre-fetch.js';

describe('hasOrNot', () => {
  it('should return false for simple WHERE clause', () => {
    const where = { id: 'user-1' };
    expect(hasOrNot(where)).toBe(false);
  });

  it('should return false for AND clause without OR/NOT', () => {
    const where = {
      AND: [{ id: 'user-1' }, { status: 'active' }],
    };
    expect(hasOrNot(where)).toBe(false);
  });

  it('should return true for OR clause', () => {
    const where = {
      OR: [{ id: 'user-1' }, { email: 'user@example.com' }],
    };
    expect(hasOrNot(where)).toBe(true);
  });

  it('should return true for NOT clause', () => {
    const where = {
      NOT: { status: 'deleted' },
    };
    expect(hasOrNot(where)).toBe(true);
  });

  it('should return true for nested NOT in AND', () => {
    const where = {
      AND: [{ id: 'user-1' }, { NOT: { status: 'deleted' } }],
    };
    expect(hasOrNot(where)).toBe(true);
  });

  it('should return true for nested OR in AND', () => {
    const where = {
      AND: [{ status: 'active' }, { OR: [{ id: 'user-1' }, { email: 'user@example.com' }] }],
    };
    expect(hasOrNot(where)).toBe(true);
  });
});

describe('matchesUniqueConstraint', () => {
  const constraints: UniqueConstraint[] = [
    { type: 'primaryKey', fields: ['id'] },
    { type: 'uniqueField', fields: ['email'] },
    { type: 'uniqueIndex', fields: ['firstName', 'lastName'], name: 'firstName_lastName' },
  ];

  it('should match single-field primary key', () => {
    const where = { id: 'user-1' };
    const matched = matchesUniqueConstraint(where, constraints);
    expect(matched).toEqual({ type: 'primaryKey', fields: ['id'] });
  });

  it('should match single-field unique constraint', () => {
    const where = { email: 'user@example.com' };
    const matched = matchesUniqueConstraint(where, constraints);
    expect(matched).toEqual({ type: 'uniqueField', fields: ['email'] });
  });

  it('should match composite unique index', () => {
    const where = { firstName: 'John', lastName: 'Doe' };
    const matched = matchesUniqueConstraint(where, constraints);
    expect(matched).toEqual({
      type: 'uniqueIndex',
      fields: ['firstName', 'lastName'],
      name: 'firstName_lastName',
    });
  });

  it('should NOT match incomplete composite key', () => {
    const where = { firstName: 'John' };
    const matched = matchesUniqueConstraint(where, constraints);
    expect(matched).toBeNull();
  });

  it('should NOT match extra fields', () => {
    const where = { id: 'user-1', name: 'John' };
    const matched = matchesUniqueConstraint(where, constraints);
    expect(matched).toBeNull();
  });

  it('should NOT match non-unique fields', () => {
    const where = { name: 'John' };
    const matched = matchesUniqueConstraint(where, constraints);
    expect(matched).toBeNull();
  });
});

const schemaMetadataFor = (constraints: UniqueConstraint[]): SchemaMetadata => ({
  getUniqueConstraints: () => constraints,
  getRelationFields: () => [],
  getAllFields: () => [],
  getFieldMetadata: () => undefined,
});

describe('parseWhereClause', () => {
  const schemaMetadata = schemaMetadataFor([
    { type: 'primaryKey', fields: ['id'] },
    { type: 'uniqueField', fields: ['email'] },
    { type: 'uniqueIndex', fields: ['firstName', 'lastName'], name: 'firstName_lastName' },
  ]);

  it('should parse simple unique field to findUnique', () => {
    const where = { id: 'user-1' };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findUnique');
    expect(parsed.where).toEqual({ id: 'user-1' });
  });

  it('should parse email unique field to findUnique', () => {
    const where = { email: 'user@example.com' };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findUnique');
    expect(parsed.where).toEqual({ email: 'user@example.com' });
  });

  it('should parse composite unique index to findUnique with transformed WHERE', () => {
    const where = { firstName: 'John', lastName: 'Doe' };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findUnique');
    expect(parsed.where).toEqual({
      firstName_lastName: {
        firstName: 'John',
        lastName: 'Doe',
      },
    });
  });

  it('should parse OR clause to findMany', () => {
    const where = { OR: [{ id: 'user-1' }, { email: 'user@example.com' }] };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findMany');
    expect(parsed.where).toEqual(where);
  });

  it('should parse NOT clause to findMany', () => {
    const where = { NOT: { status: 'deleted' } };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findMany');
  });

  it('should parse non-unique field to findMany', () => {
    const where = { name: 'John' };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findMany');
  });

  it('should parse extra fields to findMany', () => {
    const where = { id: 'user-1', name: 'John' };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.type).toBe('findMany');
  });

  it('should preserve originalWhere', () => {
    const where = { id: 'user-1' };
    const parsed = parseWhereClause(schemaMetadata, 'User', where);
    expect(parsed.originalWhere).toEqual(where);
  });
});

describe('executePreFetch', () => {
  it('should execute findUnique successfully', async () => {
    const mockClient = {
      user: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id === 'user-1') {
            return { id: 'user-1', email: 'user@example.com', name: 'John' };
          }
          return null;
        },
      },
    };

    const query = { type: 'findUnique' as const, where: { id: 'user-1' } };
    const result = await executePreFetch(mockClient, 'user', query);

    expect(result.success).toBe(true);
    expect(result.before).toEqual({ id: 'user-1', email: 'user@example.com', name: 'John' });
    expect(result.error).toBeUndefined();
  });

  it('should execute findMany successfully', async () => {
    const mockClient = {
      user: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.name === 'John') {
            return [
              { id: 'user-1', email: 'user1@example.com', name: 'John' },
              { id: 'user-2', email: 'user2@example.com', name: 'John' },
            ];
          }
          return [];
        },
      },
    };

    const query = { type: 'findMany' as const, where: { name: 'John' } };
    const result = await executePreFetch(mockClient, 'user', query);

    expect(result.success).toBe(true);
    expect(result.before).toHaveLength(2);
  });

  it('should return null when findUnique finds no record', async () => {
    const mockClient = {
      user: {
        findUnique: async () => null,
      },
    };

    const query = { type: 'findUnique' as const, where: { id: 'non-existent' } };
    const result = await executePreFetch(mockClient, 'user', query);

    expect(result.success).toBe(true);
    expect(result.before).toBeNull();
  });

  it('should return empty array when findMany finds no records', async () => {
    const mockClient = {
      user: {
        findMany: async () => [],
      },
    };

    const query = { type: 'findMany' as const, where: { name: 'NonExistent' } };
    const result = await executePreFetch(mockClient, 'user', query);

    expect(result.success).toBe(true);
    expect(result.before).toEqual([]);
  });

  it('should handle errors gracefully', async () => {
    const mockClient = {
      user: {
        findUnique: async () => {
          throw new Error('Database connection failed');
        },
      },
    };

    const query = { type: 'findUnique' as const, where: { id: 'user-1' } };
    const result = await executePreFetch(mockClient, 'user', query);

    expect(result.success).toBe(false);
    expect(result.before).toBeNull();
    expect(result.error).toBe('Database connection failed');
  });
});

describe('preFetchBeforeState', () => {
  const schemaMetadata = schemaMetadataFor([
    { type: 'primaryKey', fields: ['id'] },
    { type: 'uniqueField', fields: ['email'] },
  ]);

  it('should fetch "before" state with findUnique', async () => {
    const mockClient = {
      user: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id === 'user-1') {
            return { id: 'user-1', email: 'user@example.com' };
          }
          return null;
        },
      },
    };

    const result = await preFetchBeforeState(mockClient, schemaMetadata, 'User', { id: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.before).toEqual({ id: 'user-1', email: 'user@example.com' });
  });

  it('should fetch "before" state with findMany', async () => {
    const mockClient = {
      user: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.name === 'John') {
            return [
              { id: 'user-1', email: 'user1@example.com', name: 'John' },
              { id: 'user-2', email: 'user2@example.com', name: 'John' },
            ];
          }
          return [];
        },
      },
    };

    const result = await preFetchBeforeState(mockClient, schemaMetadata, 'User', { name: 'John' });

    expect(result.success).toBe(true);
    expect(result.before).toHaveLength(2);
  });

  it('should handle model name case conversion', async () => {
    const mockClient = {
      user: {
        findUnique: async () => ({ id: 'user-1', email: 'user@example.com' }),
      },
    };

    // PascalCase model name should be converted to camelCase for client access
    const result = await preFetchBeforeState(mockClient, schemaMetadata, 'User', { id: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.before).toBeDefined();
  });

  it('should handle errors from executePreFetch', async () => {
    const mockClient = {
      user: {
        findUnique: async () => {
          throw new Error('Network error');
        },
      },
    };

    const result = await preFetchBeforeState(mockClient, schemaMetadata, 'User', { id: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.before).toBeNull();
    expect(result.error).toBe('Network error');
  });
});
