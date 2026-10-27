import { describe, expect, it } from 'vitest';
import { auditedModelsWrittenBy } from '../../src/utils/audited-models.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

// Post holds the foreign key of User.posts and Profile that of User.profile; Post.categories is an
// implicit many-to-many relation
const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true }),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
    relation('profile', 'Profile', 'UserProfile'),
  ]),
  model('Post', [
    column('id', { isId: true }),
    column('authorId'),
    relation('author', 'User', 'UserPosts', {
      isRequired: true,
      foreignKeyFields: ['authorId'],
      referencedFields: ['id'],
    }),
    relation('categories', 'Category', 'PostCategories', { isList: true }),
  ]),
  model('Profile', [
    column('id', { isId: true }),
    column('userId'),
    relation('user', 'User', 'UserProfile', {
      isRequired: true,
      foreignKeyFields: ['userId'],
      referencedFields: ['id'],
    }),
  ]),
  model('Category', [column('id', { isId: true }), relation('posts', 'Post', 'PostCategories', { isList: true })]),
);

const every = () => true;
const written = (modelName: string, args: unknown, shouldAudit: (modelName: string) => boolean = every) =>
  auditedModelsWrittenBy(schemaMetadata, shouldAudit, modelName, args);

describe('auditedModelsWrittenBy', () => {
  it('is the model of an operation without nested writes', () => {
    expect(written('User', { data: { id: 'u1' } })).toEqual(['User']);
    expect(written('User', { where: { id: 'u1' } })).toEqual(['User']);
    expect(written('User', undefined)).toEqual(['User']);
  });

  it('adds the models nested writes write rows of, below any depth, each once', () => {
    expect(
      written('User', {
        data: {
          posts: { create: [{ id: 'p1', categories: { create: { id: 'c1' } } }], update: { where: {}, data: {} } },
          profile: { create: { id: 'pr1' } },
        },
      }),
    ).toEqual(['User', 'Post', 'Category', 'Profile']);
  });

  it('keeps only the audited models, the operation model included', () => {
    const shouldAudit = (modelName: string) => modelName === 'Post';

    expect(written('User', { data: { posts: { create: { id: 'p1' } } } }, shouldAudit)).toEqual(['Post']);
    expect(written('User', { data: { id: 'u1' } }, shouldAudit)).toEqual([]);
  });

  it.each(['create', 'createMany', 'update', 'upsert', 'delete', 'updateMany', 'deleteMany', 'connectOrCreate'])(
    'adds the related model of a nested %s, which writes rows of it',
    (keyword) => {
      const data = keyword === 'createMany' ? { data: [{ id: 'p1' }] } : { where: { id: 'p1' } };

      expect(written('User', { data: { posts: { [keyword]: data } } })).toEqual(['User', 'Post']);
    },
  );

  describe('a nested connect, set or disconnect, by the side of the foreign key', () => {
    it.each([
      ['connect', { id: 'p1' }],
      ['set', [{ id: 'p1' }]],
      ['disconnect', { id: 'p1' }],
    ])('adds the related model when the related rows hold the foreign key (%s on User.posts)', (keyword, data) => {
      expect(written('User', { data: { posts: { [keyword]: data } } })).toEqual(['User', 'Post']);
    });

    it.each([
      ['connect', { id: 'pr1' }],
      ['disconnect', true],
    ])(
      'adds the related model of a to-one relation whose related row holds the foreign key (%s on User.profile)',
      (keyword, data) => {
        expect(written('User', { data: { profile: { [keyword]: data } } })).toEqual(['User', 'Profile']);
      },
    );

    it('leaves out the related model when the parent row holds the foreign key', () => {
      expect(written('Post', { data: { author: { connect: { id: 'u1' } } } })).toEqual(['Post']);
    });

    it.each([
      ['connect', { id: 'c1' }],
      ['set', [{ id: 'c1' }]],
      ['disconnect', { id: 'c1' }],
    ])(
      'leaves out the related model of an implicit many-to-many relation, which writes only its join table (%s)',
      (keyword, data) => {
        expect(written('Post', { data: { categories: { [keyword]: data } } })).toEqual(['Post']);
      },
    );

    it('adds the related model of a connectOrCreate on an implicit many-to-many relation, which may create its row', () => {
      expect(
        written('Post', { data: { categories: { connectOrCreate: { where: { id: 'c1' }, create: { id: 'c1' } } } } }),
      ).toEqual(['Post', 'Category']);
    });
  });

  it('scans every branch of a top-level and a nested upsert', () => {
    expect(
      written('User', {
        where: { id: 'u1' },
        create: { posts: { create: { id: 'p1' } } },
        update: { profile: { upsert: { create: { id: 'pr1' }, update: {} } } },
      }),
    ).toEqual(['User', 'Post', 'Profile']);
    expect(
      written('User', {
        where: { id: 'u1' },
        create: {},
        update: {
          posts: { upsert: { where: { id: 'p1' }, create: { categories: { create: { id: 'c1' } } }, update: {} } },
        },
      }),
    ).toEqual(['User', 'Post', 'Category']);
  });

  it('counts no nested value that writes no row: false, or an empty list', () => {
    expect(
      written('User', {
        data: { profile: { delete: false, disconnect: false }, posts: { create: [], connect: [], deleteMany: [] } },
      }),
    ).toEqual(['User']);
  });

  it('counts set: [], which unlinks every related row', () => {
    expect(written('User', { data: { posts: { set: [] } } })).toEqual(['User', 'Post']);
  });
});
