import { describe, expect, it } from 'vitest';
import { getModelAccessor } from '../src/utils/model-accessor.js';

/**
 * Type guard to check if a value is a Prisma model delegate
 */
const isPrismaModelDelegate = (value: unknown): value is Record<string, unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'findMany' in value &&
    typeof (value as { findMany: unknown }).findMany === 'function'
  );
};

/**
 * Safely access model delegate from Prisma client
 */
const getModelDelegate = (client: unknown, accessor: string): Record<string, unknown> | undefined => {
  if (typeof client !== 'object' || client === null) {
    return undefined;
  }

  const delegate = (client as Record<string, unknown>)[accessor];
  return isPrismaModelDelegate(delegate) ? delegate : undefined;
};

describe('getModelAccessor', () => {
  // Use a mock object instead of actual PrismaClient
  const prisma = {} as Record<string, unknown>;

  it('should return correct accessor for User model', () => {
    const accessor = getModelAccessor(prisma, 'User');
    expect(accessor).toBe('user');

    const delegate = getModelDelegate(prisma, accessor);
    expect(delegate).toBeDefined();
  });

  it('should return correct accessor for Post model', () => {
    const accessor = getModelAccessor(prisma, 'Post');
    expect(accessor).toBe('post');

    const delegate = getModelDelegate(prisma, accessor);
    expect(delegate).toBeDefined();
  });

  it('should handle missing DMMF gracefully', () => {
    const mockClient = {} as Record<string, unknown>;
    const accessor = getModelAccessor(mockClient, 'User');
    expect(accessor).toBe('user');
  });

  it('should handle snake_case naming convention', () => {
    // TODO: Add test with schema that uses snake_case
    // generator client {
    //   provider = "prisma-client-js"
    //   namingConvention = "snake_case"
    // }
  });
});
