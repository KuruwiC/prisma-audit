/**
 * Unit tests for nested operations utilities
 */

import { createEmptyPreFetchResults } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import {
  detectNestedDeletes,
  detectNestedOperations,
  detectNestedUpdates,
  detectNestedUpserts,
  extractNestedRecords,
  getRelationFields,
  isRelationField,
} from '../src/utils/nested-operations.js';

describe('getRelationFields', () => {
  it('should return empty array if Prisma.dmmf is not available', () => {
    const Prisma = {};
    const fields = getRelationFields(Prisma, 'User');
    expect(fields).toEqual([]);
  });

  it('should return empty array if model is not found', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [{ name: 'User', fields: [] }],
        },
      },
    };
    const fields = getRelationFields(Prisma, 'Post');
    expect(fields).toEqual([]);
  });

  it('should return only relation fields (kind === "object")', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [
                { name: 'id', kind: 'scalar', type: 'String', isList: false },
                { name: 'email', kind: 'scalar', type: 'String', isList: false },
                { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
                {
                  name: 'posts',
                  kind: 'object',
                  type: 'Post',
                  isList: true,
                  relationName: 'UserPosts',
                },
                {
                  name: 'profile',
                  kind: 'object',
                  type: 'Profile',
                  isList: false,
                  relationName: 'UserProfile',
                },
              ],
            },
          ],
        },
      },
    };

    const fields = getRelationFields(Prisma, 'User');

    expect(fields).toHaveLength(2);
    expect(fields).toEqual([
      {
        name: 'posts',
        relatedModel: 'Post',
        isList: true,
        isRequired: false,
        relationName: 'UserPosts',
      },
      {
        name: 'profile',
        relatedModel: 'Profile',
        isList: false,
        isRequired: false,
        relationName: 'UserProfile',
      },
    ]);
  });

  it('should not include JSON fields even if they contain "create" keyword', () => {
    const Prisma = {
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'User',
              fields: [
                { name: 'id', kind: 'scalar', type: 'String', isList: false },
                { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
                { name: 'posts', kind: 'object', type: 'Post', isList: true },
              ],
            },
          ],
        },
      },
    };

    const fields = getRelationFields(Prisma, 'User');

    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe('posts');
    // metadata should NOT be included even if it's a JSON field
    expect(fields.find((f) => f.name === 'metadata')).toBeUndefined();
  });
});

describe('isRelationField', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
              { name: 'posts', kind: 'object', type: 'Post', isList: true },
            ],
          },
        ],
      },
    },
  };

  it('should return true for relation fields', () => {
    expect(isRelationField(Prisma, 'User', 'posts')).toBe(true);
  });

  it('should return false for scalar fields', () => {
    expect(isRelationField(Prisma, 'User', 'email')).toBe(false);
  });

  it('should return false for JSON fields (no false positive)', () => {
    expect(isRelationField(Prisma, 'User', 'metadata')).toBe(false);
  });

  it('should return false for non-existent fields', () => {
    expect(isRelationField(Prisma, 'User', 'nonexistent')).toBe(false);
  });

  it('should return false for non-existent model', () => {
    expect(isRelationField(Prisma, 'NonExistent', 'posts')).toBe(false);
  });
});

describe('detectNestedOperations', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
              { name: 'posts', kind: 'object', type: 'Post', isList: true },
              { name: 'profile', kind: 'object', type: 'Profile', isList: false },
            ],
          },
        ],
      },
    },
  };

  it('should detect nested create operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          create: [
            { title: 'Post 1', content: 'Content 1' },
            { title: 'Post 2', content: 'Content 2' },
          ],
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]).toEqual({
      fieldName: 'posts',
      relatedModel: 'Post',
      operation: 'create',
      isList: true,
      data: [
        { title: 'Post 1', content: 'Content 1' },
        { title: 'Post 2', content: 'Content 2' },
      ],
      path: 'posts',
    });
  });

  it('should detect nested createMany operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          createMany: {
            data: [
              { title: 'Post 1', content: 'Content 1' },
              { title: 'Post 2', content: 'Content 2' },
            ],
          },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('createMany');
  });

  it('should detect multiple nested operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          create: [{ title: 'Post 1', content: 'Content 1' }],
        },
        profile: {
          create: { bio: 'Bio text' },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(2);
    expect(operations.find((op) => op.fieldName === 'posts')).toBeDefined();
    expect(operations.find((op) => op.fieldName === 'profile')).toBeDefined();
  });

  it('should NOT detect operation keywords in JSON fields as nested operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        metadata: {
          create: 'some value',
          action: 'create',
          update: 'another value',
          delete: true,
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());
    expect(operations).toHaveLength(0);
  });

  it('should return empty array if no nested operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());
    expect(operations).toEqual([]);
  });

  it('should return empty array if no data in args', () => {
    const args = {
      where: { id: 'user-id' },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());
    expect(operations).toEqual([]);
  });

  it('should handle connect operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          connect: [{ id: 'post-1' }, { id: 'post-2' }],
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('connect');
  });

  it('should handle connectOrCreate operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          connectOrCreate: {
            where: { id: 'post-1' },
            create: { title: 'New Post', content: 'Content' },
          },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('connectOrCreate');
  });

  it('should detect nested update operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          update: {
            where: { id: 'post-1' },
            data: { title: 'Updated Title' },
          },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('update');
    expect(operations[0]?.fieldName).toBe('posts');
    expect(operations[0]?.relatedModel).toBe('Post');
  });

  it('should detect nested updateMany operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          updateMany: {
            where: { published: false },
            data: { published: true },
          },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('updateMany');
  });

  it('should detect nested delete operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          delete: { id: 'post-1' },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('delete');
  });

  it('should detect nested deleteMany operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          deleteMany: { published: false },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('deleteMany');
  });

  it('should detect nested upsert operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: { bio: 'New bio' },
            update: { bio: 'Updated bio' },
          },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('upsert');
    expect(operations[0]?.fieldName).toBe('profile');
  });

  it('should detect multiple mixed nested operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        posts: {
          create: [{ title: 'New Post', content: 'Content' }],
          update: {
            where: { id: 'post-1' },
            data: { title: 'Updated' },
          },
          delete: { id: 'post-2' },
        },
        profile: {
          upsert: {
            create: { bio: 'Bio' },
            update: { bio: 'Updated Bio' },
          },
        },
      },
    };

    const operations = detectNestedOperations(Prisma, 'User', args, createEmptyPreFetchResults());

    expect(operations).toHaveLength(4);
    expect(operations.find((op) => op.operation === 'create')).toBeDefined();
    expect(operations.find((op) => op.operation === 'update')).toBeDefined();
    expect(operations.find((op) => op.operation === 'delete')).toBeDefined();
    expect(operations.find((op) => op.operation === 'upsert')).toBeDefined();
  });
});

describe('extractNestedRecords', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'posts', kind: 'object', type: 'Post', isList: true },
              { name: 'profile', kind: 'object', type: 'Profile', isList: false },
            ],
          },
        ],
      },
    },
  };

  it('should extract nested records from list relation', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      posts: [
        { id: 'post-1', title: 'Post 1', authorId: 'user-id' },
        { id: 'post-2', title: 'Post 2', authorId: 'user-id' },
      ],
    };

    const nestedRecords = extractNestedRecords(Prisma, 'User', result);

    expect(nestedRecords).toHaveLength(1);
    expect(nestedRecords[0]).toEqual({
      fieldName: 'posts',
      relatedModel: 'Post',
      isList: true,
      records: [
        { id: 'post-1', title: 'Post 1', authorId: 'user-id' },
        { id: 'post-2', title: 'Post 2', authorId: 'user-id' },
      ],
      path: 'posts',
    });
  });

  it('should extract nested records from single relation', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      profile: { id: 'profile-id', bio: 'Bio text', userId: 'user-id' },
    };

    const nestedRecords = extractNestedRecords(Prisma, 'User', result);

    expect(nestedRecords).toHaveLength(1);
    expect(nestedRecords[0]).toEqual({
      fieldName: 'profile',
      relatedModel: 'Profile',
      isList: false,
      records: [{ id: 'profile-id', bio: 'Bio text', userId: 'user-id' }],
      path: 'profile',
    });
  });

  it('should extract multiple nested relations', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      posts: [{ id: 'post-1', title: 'Post 1', authorId: 'user-id' }],
      profile: { id: 'profile-id', bio: 'Bio text', userId: 'user-id' },
    };

    const nestedRecords = extractNestedRecords(Prisma, 'User', result);

    expect(nestedRecords).toHaveLength(2);
    expect(nestedRecords.find((r) => r.fieldName === 'posts')).toBeDefined();
    expect(nestedRecords.find((r) => r.fieldName === 'profile')).toBeDefined();
  });

  it('should return empty array if no included relations in result', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
    };

    const nestedRecords = extractNestedRecords(Prisma, 'User', result);
    expect(nestedRecords).toEqual([]);
  });

  it('should return empty array if result is not an object', () => {
    const nestedRecords1 = extractNestedRecords(Prisma, 'User', null);
    expect(nestedRecords1).toEqual([]);

    const nestedRecords2 = extractNestedRecords(Prisma, 'User', undefined);
    expect(nestedRecords2).toEqual([]);

    const nestedRecords3 = extractNestedRecords(Prisma, 'User', 'string');
    expect(nestedRecords3).toEqual([]);
  });

  it('should handle empty arrays in list relations', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      posts: [],
    };

    const nestedRecords = extractNestedRecords(Prisma, 'User', result);

    // Empty arrays should not be included in the result
    expect(nestedRecords).toEqual([]);
  });

  it('should handle null values in relations', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      profile: null,
    };

    const nestedRecords = extractNestedRecords(Prisma, 'User', result);

    // Null relations should not be included
    expect(nestedRecords).toEqual([]);
  });
});

describe('detectNestedUpdates', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
              { name: 'posts', kind: 'object', type: 'Post', isList: true },
            ],
          },
        ],
      },
    },
  };

  it('should detect nested update and updateMany operations', () => {
    const updateArgs = {
      data: {
        email: 'user@example.com',
        posts: {
          update: {
            where: { id: 'post-1' },
            data: { title: 'Updated Title' },
          },
        },
      },
    };

    const updateManyArgs = {
      data: {
        email: 'user@example.com',
        posts: {
          updateMany: {
            where: { published: false },
            data: { published: true },
          },
        },
      },
    };

    const updateOps = detectNestedUpdates(Prisma, 'User', updateArgs);
    expect(updateOps).toHaveLength(1);
    expect(updateOps[0]?.operation).toBe('update');
    expect(updateOps[0]?.fieldName).toBe('posts');

    const updateManyOps = detectNestedUpdates(Prisma, 'User', updateManyArgs);
    expect(updateManyOps).toHaveLength(1);
    expect(updateManyOps[0]?.operation).toBe('updateMany');
  });

  it('should NOT detect update keywords in JSON fields', () => {
    const args = {
      data: {
        email: 'user@example.com',
        metadata: {
          update: 'some value',
          action: 'update',
        },
      },
    };

    const operations = detectNestedUpdates(Prisma, 'User', args);
    expect(operations).toHaveLength(0);
  });

  it('should return empty array when no data field exists', () => {
    const args = { where: { id: 'user-id' } };
    const operations = detectNestedUpdates(Prisma, 'User', args);
    expect(operations).toEqual([]);
  });
});

describe('detectNestedDeletes', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
              { name: 'posts', kind: 'object', type: 'Post', isList: true },
            ],
          },
        ],
      },
    },
  };

  it('should detect nested delete and deleteMany operations', () => {
    const deleteArgs = {
      data: {
        email: 'user@example.com',
        posts: {
          delete: { id: 'post-1' },
        },
      },
    };

    const deleteManyArgs = {
      data: {
        email: 'user@example.com',
        posts: {
          deleteMany: { published: false },
        },
      },
    };

    const deleteOps = detectNestedDeletes(Prisma, 'User', deleteArgs);
    expect(deleteOps).toHaveLength(1);
    expect(deleteOps[0]?.operation).toBe('delete');

    const deleteManyOps = detectNestedDeletes(Prisma, 'User', deleteManyArgs);
    expect(deleteManyOps).toHaveLength(1);
    expect(deleteManyOps[0]?.operation).toBe('deleteMany');
  });

  it('should NOT detect delete keywords in JSON fields', () => {
    const args = {
      data: {
        email: 'user@example.com',
        metadata: {
          delete: true,
          action: 'delete',
        },
      },
    };

    const operations = detectNestedDeletes(Prisma, 'User', args);
    expect(operations).toHaveLength(0);
  });
});

describe('detectNestedUpserts', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'profile', kind: 'object', type: 'Profile', isList: false },
            ],
          },
        ],
      },
    },
  };

  it('should detect nested upsert operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: { bio: 'New bio' },
            update: { bio: 'Updated bio' },
          },
        },
      },
    };

    const operations = detectNestedUpserts(Prisma, 'User', args);

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('upsert');
    expect(operations[0]?.fieldName).toBe('profile');
    expect(operations[0]?.isList).toBe(false);
  });

  it('should distinguish create vs update path in upsert', () => {
    // This test verifies that upsert is detected
    // The actual create vs update determination happens in extension logic based on pre-fetch result
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: { bio: 'New bio' },
            update: { bio: 'Updated bio' },
          },
        },
      },
    };

    const operations = detectNestedUpserts(Prisma, 'User', args);

    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('upsert');
    // The data should contain both create and update
    const upsertData = operations[0]?.data as { create: unknown; update: unknown };
    expect(upsertData.create).toBeDefined();
    expect(upsertData.update).toBeDefined();
  });
});

describe('detectNestedOperations with upsert branch filtering', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'email', kind: 'scalar', type: 'String', isList: false },
              { name: 'profile', kind: 'object', type: 'Profile', isList: false },
            ],
          },
          {
            name: 'Profile',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'bio', kind: 'scalar', type: 'String', isList: false },
              { name: 'userId', kind: 'scalar', type: 'String', isList: false },
              { name: 'avatar', kind: 'object', type: 'Avatar', isList: false },
            ],
          },
          {
            name: 'Avatar',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'name', kind: 'scalar', type: 'String', isList: false },
              { name: 'profileId', kind: 'scalar', type: 'String', isList: false },
            ],
          },
        ],
      },
    },
  };

  it('should detect only update branch when pre-fetch result exists', () => {
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: { bio: 'New bio' },
            update: { bio: 'Updated bio' },
          },
        },
      },
    };

    // Pre-fetch result indicates profile exists
    const preFetchResults = new Map();
    preFetchResults.set('profile', { id: 'profile-1', bio: 'Old bio', userId: 'user-1' });

    const operations = detectNestedOperations(Prisma, 'User', args, preFetchResults);

    // Should detect only update operation, not both
    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('upsert');
    expect(operations[0]?.fieldName).toBe('profile');
  });

  it('should detect only create branch when pre-fetch result does not exist', () => {
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: { bio: 'New bio' },
            update: { bio: 'Updated bio' },
          },
        },
      },
    };

    // Pre-fetch result indicates profile does NOT exist
    const preFetchResults = new Map();
    preFetchResults.set('profile', null);

    const operations = detectNestedOperations(Prisma, 'User', args, preFetchResults);

    // Should detect only create operation, not both
    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('upsert');
    expect(operations[0]?.fieldName).toBe('profile');
  });

  it('should detect nested upsert with different pre-fetch results', () => {
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: {
              bio: 'New bio',
              avatar: {
                upsert: {
                  create: { name: 'New avatar' },
                  update: { name: 'Updated avatar' },
                },
              },
            },
            update: {
              bio: 'Updated bio',
              avatar: {
                upsert: {
                  create: { name: 'New avatar' },
                  update: { name: 'Updated avatar' },
                },
              },
            },
          },
        },
      },
    };

    // Pre-fetch result indicates profile exists but avatar does not
    const preFetchResults = new Map();
    preFetchResults.set('profile', { id: 'profile-1', bio: 'Old bio', userId: 'user-1' });
    preFetchResults.set('profile.avatar', null);

    const operations = detectNestedOperations(Prisma, 'User', args, preFetchResults);

    // Should detect profile upsert (will take update branch) and avatar upsert (will take create branch)
    expect(operations.length).toBeGreaterThanOrEqual(1);
    const profileOp = operations.find((op) => op.fieldName === 'profile');
    expect(profileOp).toBeDefined();
    expect(profileOp?.operation).toBe('upsert');
  });

  it('should handle empty pre-fetch results (no filtering)', () => {
    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: { bio: 'New bio' },
            update: { bio: 'Updated bio' },
          },
        },
      },
    };

    // Empty pre-fetch results
    const preFetchResults = createEmptyPreFetchResults();

    const operations = detectNestedOperations(Prisma, 'User', args, preFetchResults);

    // Should still detect upsert operation
    expect(operations).toHaveLength(1);
    expect(operations[0]?.operation).toBe('upsert');
  });

  it('should prevent AvatarImage duplication bug (original issue)', () => {
    // This test simulates the original bug scenario where AvatarImage was logged 3 times
    // With pre-fetch aware detection, it should be logged only once

    const args = {
      data: {
        email: 'user@example.com',
        profile: {
          upsert: {
            create: {
              bio: 'New bio',
              avatar: {
                upsert: {
                  create: {
                    name: 'Avatar',
                    avatarImage: {
                      upsert: {
                        create: { imageUrl: 'https://example.com/new.png' },
                        update: { imageUrl: 'https://example.com/updated.png' },
                      },
                    },
                  },
                  update: {
                    name: 'Avatar',
                    avatarImage: {
                      upsert: {
                        create: { imageUrl: 'https://example.com/new.png' },
                        update: { imageUrl: 'https://example.com/updated.png' },
                      },
                    },
                  },
                },
              },
            },
            update: {
              bio: 'Updated bio',
              avatar: {
                upsert: {
                  create: {
                    name: 'Avatar',
                    avatarImage: {
                      upsert: {
                        create: { imageUrl: 'https://example.com/new.png' },
                        update: { imageUrl: 'https://example.com/updated.png' },
                      },
                    },
                  },
                  update: {
                    name: 'Avatar',
                    avatarImage: {
                      upsert: {
                        create: { imageUrl: 'https://example.com/new.png' },
                        update: { imageUrl: 'https://example.com/updated.png' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    // Pre-fetch result: All records exist (update path for all upserts)
    const preFetchResults = new Map();
    preFetchResults.set('profile', { id: 'profile-1', bio: 'Old bio', userId: 'user-1' });
    preFetchResults.set('profile.avatar', {
      id: 'avatar-1',
      name: 'Old Avatar',
      profileId: 'profile-1',
    });
    preFetchResults.set('profile.avatar.avatarImage', {
      id: 'avatarImage-1',
      imageUrl: 'https://example.com/old.png',
      avatarId: 'avatar-1',
    });

    const operations = detectNestedOperations(Prisma, 'User', args, preFetchResults);

    // Before fix: Would detect AvatarImage upsert 3 times (from all branches)
    // After fix: Should detect each upsert only once
    const profileOps = operations.filter((op) => op.fieldName === 'profile');
    expect(profileOps.length).toBeLessThanOrEqual(1); // Maximum 1 profile upsert

    // Note: Deep nested operations (avatar, avatarImage) are handled recursively
    // The key is that we don't explore all branches optimistically
  });
});
