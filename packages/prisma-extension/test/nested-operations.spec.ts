/**
 * Unit tests for nested operations utilities
 */

import {
  detectNestedOperations,
  extractNestedRecords,
  type NestedDetectionPass,
  type UpsertBranch,
} from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import { createSchemaMetadataFromDMMF } from '../src/utils/schema-metadata.js';

describe('getRelationFields', () => {
  it('should return empty array if Prisma.dmmf is not available', () => {
    const Prisma = {};
    const fields = createSchemaMetadataFromDMMF(Prisma).getRelationFields('User');
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
    const fields = createSchemaMetadataFromDMMF(Prisma).getRelationFields('Post');
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

    const fields = createSchemaMetadataFromDMMF(Prisma).getRelationFields('User');

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

    const fields = createSchemaMetadataFromDMMF(Prisma).getRelationFields('User');

    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe('posts');
    // metadata should NOT be included even if it's a JSON field
    expect(fields.find((f) => f.name === 'metadata')).toBeUndefined();
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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });
    expect(operations).toHaveLength(0);
  });

  it('should return empty array if no nested operations', () => {
    const args = {
      data: {
        email: 'user@example.com',
      },
    };

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });
    expect(operations).toEqual([]);
  });

  it('should return empty array if no data in args', () => {
    const args = {
      where: { id: 'user-id' },
    };

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });
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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

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

    const nestedRecords = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', result);

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

    const nestedRecords = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', result);

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

    const nestedRecords = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', result);

    expect(nestedRecords).toHaveLength(2);
    expect(nestedRecords.find((r) => r.fieldName === 'posts')).toBeDefined();
    expect(nestedRecords.find((r) => r.fieldName === 'profile')).toBeDefined();
  });

  it('should return empty array if no included relations in result', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
    };

    const nestedRecords = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', result);
    expect(nestedRecords).toEqual([]);
  });

  it('should return empty array if result is not an object', () => {
    const nestedRecords1 = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', null);
    expect(nestedRecords1).toEqual([]);

    const nestedRecords2 = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', undefined);
    expect(nestedRecords2).toEqual([]);

    const nestedRecords3 = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', 'string');
    expect(nestedRecords3).toEqual([]);
  });

  it('should handle empty arrays in list relations', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      posts: [],
    };

    const nestedRecords = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', result);

    // Empty arrays should not be included in the result
    expect(nestedRecords).toEqual([]);
  });

  it('should handle null values in relations', () => {
    const result = {
      id: 'user-id',
      email: 'user@example.com',
      profile: null,
    };

    const nestedRecords = extractNestedRecords(createSchemaMetadataFromDMMF(Prisma), 'User', result);

    // Null relations should not be included
    expect(nestedRecords).toEqual([]);
  });
});

const executedPass = (existingPaths: readonly string[], topLevelUpsertBranch?: UpsertBranch): NestedDetectionPass => ({
  kind: 'executed',
  topLevelUpsertBranch,
  hasRecordAt: (path) => existingPaths.includes(path),
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
              { name: 'avatarImage', kind: 'object', type: 'AvatarImage', isList: false },
            ],
          },
          {
            name: 'AvatarImage',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'imageUrl', kind: 'scalar', type: 'String', isList: false },
              { name: 'avatarId', kind: 'scalar', type: 'String', isList: false },
            ],
          },
        ],
      },
    },
  };

  const profileUpsertArgs = {
    data: {
      email: 'user@example.com',
      profile: {
        upsert: {
          create: { bio: 'New bio', avatar: { create: { name: 'New avatar' } } },
          update: { bio: 'Updated bio', avatar: { update: { name: 'Updated avatar' } } },
        },
      },
    },
  };

  const operationKeys = (operations: { path: string; operation: string }[]) =>
    operations.map((op) => `${op.path}:${op.operation}`);

  it('should detect only the update branch when the upserted record existed', () => {
    const operations = detectNestedOperations(
      createSchemaMetadataFromDMMF(Prisma),
      'User',
      profileUpsertArgs,
      executedPass(['profile']),
    );

    expect(operationKeys(operations)).toEqual(['profile:upsert', 'profile.avatar:update']);
  });

  it('should detect only the create branch when the upserted record did not exist', () => {
    const operations = detectNestedOperations(
      createSchemaMetadataFromDMMF(Prisma),
      'User',
      profileUpsertArgs,
      executedPass([]),
    );

    expect(operationKeys(operations)).toEqual(['profile:upsert', 'profile.avatar:create']);
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

    // Profile exists but avatar does not
    const operations = detectNestedOperations(
      createSchemaMetadataFromDMMF(Prisma),
      'User',
      args,
      executedPass(['profile']),
    );

    // Profile takes the update branch (it exists) and recurses into it, reporting the nested avatar
    // upsert once regardless of which of its own branches it will take.
    expect(operationKeys(operations)).toEqual(['profile:upsert', 'profile.avatar:upsert']);
  });

  it('should detect both branches in the discovery pass', () => {
    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', profileUpsertArgs, {
      kind: 'discovery',
    });

    expect(operationKeys(operations)).toEqual(['profile:upsert', 'profile.avatar:update', 'profile.avatar:create']);
  });

  it('should detect only the executed branch for a 3-level nested upsert chain', () => {
    // avatar and avatarImage repeat under both branches of their parent upsert, so scanning
    // every branch would report them once per create/update combination.

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

    // All records exist (update path for all upserts)
    const operations = detectNestedOperations(
      createSchemaMetadataFromDMMF(Prisma),
      'User',
      args,
      executedPass(['profile', 'profile.avatar', 'profile.avatar.avatarImage']),
    );

    // Each level is reported exactly once: the recursion follows only the update branch
    // the pre-fetch reports as existing, not every create/update combination down the chain.
    expect(operationKeys(operations)).toEqual([
      'profile:upsert',
      'profile.avatar:upsert',
      'profile.avatar.avatarImage:upsert',
    ]);
  });
});

describe('detectNestedOperations top-level upsert branches', () => {
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
            ],
          },
        ],
      },
    },
  };

  const args = {
    where: { id: 'user-1' },
    create: { email: 'user@example.com', profile: { create: { bio: 'Created bio' } } },
    update: { profile: { update: { bio: 'Updated bio' } } },
  };

  const detectedOperations = (pass: NestedDetectionPass) =>
    detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, pass).map(
      (op) => `${op.path}:${op.operation}`,
    );

  it('scans both branches in the discovery pass', () => {
    expect(detectedOperations({ kind: 'discovery' })).toEqual(['profile:create', 'profile:update']);
  });

  it.each(['create', 'update'] as const)('scans only the %s branch the top-level upsert executed', (branch) => {
    expect(detectedOperations(executedPass([], branch))).toEqual([`profile:${branch}`]);
  });

  it('scans neither branch in the executed pass of an operation that is not an upsert', () => {
    expect(detectedOperations(executedPass([]))).toEqual([]);
  });
});

describe('detectNestedOperations inside nested updates', () => {
  const Prisma = {
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'User',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'posts', kind: 'object', type: 'Post', isList: true },
              { name: 'profile', kind: 'object', type: 'Profile', isList: false },
            ],
          },
          {
            name: 'Profile',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'avatar', kind: 'object', type: 'Avatar', isList: false },
            ],
          },
          {
            name: 'Avatar',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'name', kind: 'scalar', type: 'String', isList: false },
            ],
          },
          {
            name: 'Post',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'comments', kind: 'object', type: 'Comment', isList: true },
            ],
          },
          {
            name: 'Comment',
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isList: false },
              { name: 'attachments', kind: 'object', type: 'Attachment', isList: true },
            ],
          },
          {
            name: 'Attachment',
            fields: [{ name: 'id', kind: 'scalar', type: 'String', isList: false }],
          },
        ],
      },
    },
  };

  const passes: [string, NestedDetectionPass][] = [
    ['discovery', { kind: 'discovery' }],
    ['executed', executedPass([])],
  ];

  const detectedOperations = (args: Record<string, unknown>, pass: NestedDetectionPass) =>
    detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, pass).map(
      (op) => `${op.path}:${op.operation}`,
    );

  describe.each(passes)('%s pass', (_name, pass) => {
    it('detects a write inside a to-one update given as the update data', () => {
      const args = { data: { profile: { update: { avatar: { create: { name: 'Avatar' } } } } } };

      expect(detectedOperations(args, pass)).toEqual(['profile:update', 'profile.avatar:create']);
    });

    it('detects a write inside a to-one update given as { where, data }', () => {
      const args = {
        data: { profile: { update: { where: { id: 'profile-1' }, data: { avatar: { create: { name: 'Avatar' } } } } } },
      };

      expect(detectedOperations(args, pass)).toEqual(['profile:update', 'profile.avatar:create']);
    });

    it('detects a write inside a to-many update given as one { where, data }', () => {
      const args = {
        data: { posts: { update: { where: { id: 'post-1' }, data: { comments: { create: { id: 'comment-1' } } } } } },
      };

      expect(detectedOperations(args, pass)).toEqual(['posts:update', 'posts.comments:create']);
    });

    it('detects writes inside a to-many update given as a list of { where, data }', () => {
      const args = {
        data: {
          posts: {
            update: [
              { where: { id: 'post-1' }, data: { comments: { create: { id: 'comment-1' } } } },
              { where: { id: 'post-2' }, data: { comments: { createMany: { data: [{ id: 'comment-2' }] } } } },
            ],
          },
        },
      };

      expect(detectedOperations(args, pass)).toEqual([
        'posts:update',
        'posts.comments:create',
        'posts.comments:createMany',
      ]);
    });

    it('detects writes inside an update nested in another nested update', () => {
      const args = {
        data: {
          posts: {
            update: {
              where: { id: 'post-1' },
              data: {
                comments: {
                  update: { where: { id: 'comment-1' }, data: { attachments: { create: { id: 'attachment-1' } } } },
                },
              },
            },
          },
        },
      };

      expect(detectedOperations(args, pass)).toEqual([
        'posts:update',
        'posts.comments:update',
        'posts.comments.attachments:create',
      ]);
    });

    it('detects writes inside a nested update in the upsert create branch', () => {
      const args = {
        where: { id: 'user-1' },
        create: { profile: { create: {} } },
        update: {
          posts: { update: { where: { id: 'post-1' }, data: { comments: { create: { id: 'comment-1' } } } } },
        },
      };
      const upsertPass: NestedDetectionPass = pass.kind === 'discovery' ? pass : executedPass([], 'update');

      expect(detectedOperations(args, upsertPass)).toEqual(
        pass.kind === 'discovery'
          ? ['profile:create', 'posts:update', 'posts.comments:create']
          : ['posts:update', 'posts.comments:create'],
      );
    });
  });

  it('scans only the executed branch of an upsert nested inside a nested update', () => {
    const args = {
      data: {
        posts: {
          update: {
            where: { id: 'post-1' },
            data: {
              comments: {
                upsert: {
                  where: { id: 'comment-1' },
                  create: { attachments: { create: { id: 'attachment-1' } } },
                  update: { attachments: { deleteMany: {} } },
                },
              },
            },
          },
        },
      },
    };

    expect(detectedOperations(args, { kind: 'discovery' })).toEqual([
      'posts:update',
      'posts.comments:upsert',
      'posts.comments.attachments:deleteMany',
      'posts.comments.attachments:create',
    ]);
    expect(detectedOperations(args, executedPass(['posts.comments']))).toEqual([
      'posts:update',
      'posts.comments:upsert',
      'posts.comments.attachments:deleteMany',
    ]);
    expect(detectedOperations(args, executedPass([]))).toEqual([
      'posts:update',
      'posts.comments:upsert',
      'posts.comments.attachments:create',
    ]);
  });
});
