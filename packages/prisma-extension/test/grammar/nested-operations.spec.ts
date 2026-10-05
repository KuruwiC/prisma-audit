/**
 * Unit tests for nested operations utilities
 */

import { describe, expect, it } from 'vitest';
import {
  batchFilterClauses,
  detectNestedOperations,
  type NestedDetectionPass,
  namedTargets,
  targetWhereClauses,
  type UpsertBranch,
} from '../../src/grammar/nested-operations.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';

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
      precedingWrites: [],
    });
  });

  it('gives each operation the keywords its relation field lists before it, in the order listed', () => {
    const args = {
      where: { id: 'u1' },
      data: { posts: { delete: { id: 'p2' }, connect: { id: 'p1' }, deleteMany: { title: 'Old' } } },
    };

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

    expect(Object.fromEntries(operations.map((op) => [op.operation, op.precedingWrites]))).toEqual({
      delete: [],
      connect: [{ operation: 'delete', data: { id: 'p2' } }],
      deleteMany: [
        { operation: 'delete', data: { id: 'p2' } },
        { operation: 'connect', data: { id: 'p1' } },
      ],
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

  it('detects a disconnect, which names its rows like connect', () => {
    const args = { data: { posts: { disconnect: [{ id: 'post-1' }, { id: 'post-2' }] } } };

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
      kind: 'discovery',
    });

    expect(operations.map((operation) => operation.operation)).toEqual(['disconnect']);
    expect(namedTargets('disconnect', operations[0]?.data)).toEqual([
      { element: 0, where: { id: 'post-1' } },
      { element: 1, where: { id: 'post-2' } },
    ]);
    expect(namedTargets('disconnect', true)).toEqual([]);
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

const executedPass = (existingPaths: readonly string[], topLevelUpsertBranch?: UpsertBranch): NestedDetectionPass => ({
  kind: 'executed',
  topLevelUpsertBranch,
  branchAt: ({ path }) => (existingPaths.includes(path) ? 'update' : 'create'),
});

describe('namedTargets', () => {
  it.each(['update', 'upsert', 'connectOrCreate'] as const)(
    'names the where of each %s element, by its index in the data',
    (keyword) => {
      const data = [
        { where: { id: 'post-1' }, data: {}, create: {}, update: {} },
        { where: { title_authorId: { title: 'T', authorId: 'user-1' } }, data: {}, create: {}, update: {} },
      ];

      expect(namedTargets(keyword, data)).toEqual([
        { element: 0, where: { id: 'post-1' } },
        { element: 1, where: { title_authorId: { title: 'T', authorId: 'user-1' } } },
      ]);
    },
  );

  it.each(['delete', 'connect', 'set', 'disconnect'] as const)('names each %s element itself', (keyword) => {
    expect(namedTargets(keyword, [{ id: 'post-1' }, { id: 'post-2' }])).toEqual([
      { element: 0, where: { id: 'post-1' } },
      { element: 1, where: { id: 'post-2' } },
    ]);
  });

  it('names a single element that is not a list as element 0', () => {
    expect(namedTargets('update', { where: { id: 'post-1' }, data: {} })).toEqual([
      { element: 0, where: { id: 'post-1' } },
    ]);
    expect(namedTargets('delete', { id: 'post-1' })).toEqual([{ element: 0, where: { id: 'post-1' } }]);
  });

  it('keeps the index of the data for an element without a where', () => {
    expect(namedTargets('update', [{ data: {} }, { where: { id: 'post-2' }, data: {} }])).toEqual([
      { element: 1, where: { id: 'post-2' } },
    ]);
  });

  it.each([
    ['create', { title: 'T' }],
    ['createMany', { data: [{ title: 'T' }] }],
    ['updateMany', { where: { title: 'T' }, data: {} }],
    ['deleteMany', { title: 'T' }],
  ] as const)('names no row for %s', (keyword, data) => {
    expect(namedTargets(keyword, data)).toEqual([]);
  });
});

describe('targetWhereClauses', () => {
  it('is the where of every named target, in data order', () => {
    expect(
      targetWhereClauses('upsert', [
        { where: { id: 'post-1' }, create: {}, update: {} },
        { where: { id: 'post-2' }, create: {}, update: {} },
      ]),
    ).toEqual([{ id: 'post-1' }, { id: 'post-2' }]);
    expect(targetWhereClauses('deleteMany', { title: 'T' })).toEqual([]);
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

  it.each(['create', 'update'] as const)(
    'scans only the %s branch in the discovery pass when the top-level branch is known',
    (branch) => {
      expect(detectedOperations({ kind: 'discovery', topLevelUpsertBranch: branch })).toEqual([`profile:${branch}`]);
    },
  );

  it('scans the same keyword on the same relation in both branches in the discovery pass', () => {
    const sameKeyword = {
      where: { id: 'user-1' },
      create: { email: 'user@example.com', profile: { create: { bio: 'Created bio' } } },
      update: { profile: { create: { bio: 'Replacing bio' } } },
    };

    const operations = detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', sameKeyword, {
      kind: 'discovery',
    });

    expect(operations.map((op) => [op.path, op.operation, op.data])).toEqual([
      ['profile', 'create', { bio: 'Created bio' }],
      ['profile', 'create', { bio: 'Replacing bio' }],
    ]);
  });

  it('detects a value both branches share once', () => {
    const profile = { create: { bio: 'Shared bio' } };
    const shared = { where: { id: 'user-1' }, create: { email: 'user@example.com', profile }, update: { profile } };

    expect(
      detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', shared, { kind: 'discovery' }).map(
        (op) => `${op.path}:${op.operation}`,
      ),
    ).toEqual(['profile:create']);
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

  describe('array-form nested upsert', () => {
    const args = {
      data: {
        posts: {
          upsert: [
            {
              where: { id: 'post-1' },
              create: { title: 'never' },
              update: { comments: { create: { content: 'c1' } } },
            },
            {
              where: { id: 'missing' },
              create: { comments: { create: { content: 'c2' } } },
              update: { comments: { deleteMany: {} } },
            },
          ],
        },
      },
    };

    it('scans both branches of every element in the discovery pass', () => {
      expect(detectedOperations(args, { kind: 'discovery' })).toEqual([
        'posts:upsert',
        'posts.comments:create',
        'posts.comments:deleteMany',
        'posts.comments:create',
      ]);
    });

    it('asks whether each element targets an existing row by its own WHERE and takes its branch', () => {
      const asked: [string, Record<string, unknown> | undefined][] = [];
      const pass: NestedDetectionPass = {
        kind: 'executed',
        branchAt: ({ path }, where) => {
          asked.push([path, where]);
          return where?.id === 'post-1' ? 'update' : 'create';
        },
      };

      expect(detectedOperations(args, pass)).toEqual([
        'posts:upsert',
        'posts.comments:create',
        'posts.comments:create',
      ]);
      expect(asked).toEqual([
        ['posts', { id: 'post-1' }],
        ['posts', { id: 'missing' }],
      ]);
    });

    it('scans neither branch of an element whose target could not be read', () => {
      const pass: NestedDetectionPass = {
        kind: 'executed',
        branchAt: (_operation, where) => (where?.id === 'post-1' ? undefined : 'create'),
      };

      expect(detectedOperations(args, pass)).toEqual(['posts:upsert', 'posts.comments:create']);
    });

    it('passes no WHERE for a to-one upsert', () => {
      const asked: unknown[] = [];
      const pass: NestedDetectionPass = {
        kind: 'executed',
        branchAt: (_operation, where) => {
          asked.push(where);
          return 'create';
        },
      };

      detectedOperations({ data: { profile: { upsert: { create: {}, update: {} } } } }, pass);

      expect(asked).toEqual([undefined]);
    });
  });

  describe('the create data of a nested connectOrCreate', () => {
    const args = {
      data: {
        posts: {
          connectOrCreate: [
            { where: { id: 'post-1' }, create: { title: 'A', comments: { create: { content: 'a' } } } },
            { where: { id: 'missing' }, create: { title: 'B', comments: { create: { content: 'b' } } } },
          ],
        },
      },
    };
    const connectsPost1: NestedDetectionPass = {
      kind: 'executed',
      branchAt: (_operation, where) => (where?.id === 'post-1' ? 'update' : 'create'),
    };

    it('is scanned for every element of a list in the discovery pass', () => {
      expect(detectedOperations(args, { kind: 'discovery' })).toEqual([
        'posts:connectOrCreate',
        'posts.comments:create',
        'posts.comments:create',
      ]);
    });

    it('is scanned only for the elements that created their row in the executed pass', () => {
      expect(detectedOperations(args, connectsPost1)).toEqual(['posts:connectOrCreate', 'posts.comments:create']);
    });

    it('is not scanned for a to-one connectOrCreate that connected, nor for one whose target could not be read', () => {
      const toOne = {
        data: {
          profile: { connectOrCreate: { where: { id: 'profile-1' }, create: { avatar: { create: { name: 'A' } } } } },
        },
      };

      expect(detectedOperations(toOne, { kind: 'executed', branchAt: () => 'update' })).toEqual([
        'profile:connectOrCreate',
      ]);
      expect(detectedOperations(toOne, { kind: 'executed', branchAt: () => undefined })).toEqual([
        'profile:connectOrCreate',
      ]);
      expect(detectedOperations(toOne, { kind: 'executed', branchAt: () => 'create' })).toEqual([
        'profile:connectOrCreate',
        'profile.avatar:create',
      ]);
    });
  });

  describe('the element each operation was detected in', () => {
    const parentOf = (args: Record<string, unknown>, pass: NestedDetectionPass) =>
      detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, pass).map((op) =>
        op.parent
          ? `${op.path}:${op.operation} in ${op.parent.operation.path}:${op.parent.operation.operation}[${op.parent.element}]`
          : `${op.path}:${op.operation}`,
      );

    it('names the list element of a to-many update each nested write sits in', () => {
      const args = {
        data: {
          posts: {
            update: [
              { where: { id: 'post-1' }, data: { comments: { create: { content: 'a' } } } },
              { where: { id: 'post-2' }, data: { comments: { update: { where: { id: 'c' }, data: {} } } } },
            ],
          },
        },
      };

      expect(parentOf(args, { kind: 'discovery' })).toEqual([
        'posts:update',
        'posts.comments:create in posts:update[0]',
        'posts.comments:update in posts:update[1]',
      ]);
    });

    it('keeps the index of an upsert element when other elements are not scanned', () => {
      const args = {
        data: {
          posts: {
            upsert: [
              { where: { id: 'post-1' }, create: { comments: { create: { content: 'a' } } }, update: {} },
              { where: { id: 'missing' }, create: { comments: { create: { content: 'b' } } }, update: {} },
            ],
          },
        },
      };

      expect(
        parentOf(args, {
          kind: 'executed',
          branchAt: (_operation, where) => (where?.id === 'missing' ? 'create' : undefined),
        }),
      ).toEqual(['posts:upsert', 'posts.comments:create in posts:upsert[1]']);
    });

    it('hands a to-one upsert to the branch decision with the element it is nested in', () => {
      const asked: string[] = [];
      const args = {
        data: {
          posts: {
            update: [
              { where: { id: 'post-1' }, data: {} },
              { where: { id: 'post-2' }, data: { comments: { update: { where: { id: 'c' }, data: {} } } } },
            ],
          },
          profile: { update: { avatar: { upsert: { create: {}, update: {} } } } },
        },
      };

      detectNestedOperations(createSchemaMetadataFromDMMF(Prisma), 'User', args, {
        kind: 'executed',
        branchAt: (operation) => {
          asked.push(`${operation.path} in ${operation.parent?.operation.path}[${operation.parent?.element}]`);
          return 'update';
        },
      });

      expect(asked).toEqual(['profile.avatar in profile[0]']);
    });
  });
});

describe('batchFilterClauses', () => {
  it('takes the where of each updateMany element', () => {
    expect(batchFilterClauses('updateMany', { where: { published: false }, data: { title: 'T' } })).toEqual([
      { published: false },
    ]);
    expect(
      batchFilterClauses('updateMany', [
        { where: { published: false }, data: {} },
        { where: { title: 'A' }, data: {} },
      ]),
    ).toEqual([{ published: false }, { title: 'A' }]);
  });

  it('takes each deleteMany element as the filter itself', () => {
    expect(batchFilterClauses('deleteMany', { published: false })).toEqual([{ published: false }]);
    expect(batchFilterClauses('deleteMany', [{ published: false }, {}])).toEqual([{ published: false }, {}]);
  });

  it('drops elements that carry no filter', () => {
    expect(batchFilterClauses('updateMany', [{ data: {} }, null])).toEqual([]);
    expect(batchFilterClauses('deleteMany', [null, 'x'])).toEqual([]);
  });
});
