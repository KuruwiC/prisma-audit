import type { AuditSchema } from '@kuruwic/prisma-audit';
import type { DMMF } from '@prisma/generator-helper';
import { beforeAll, describe, expect, it } from 'vitest';
import { toAuditSchema } from '../src/to-audit-schema.js';
import { loadFixtureDatamodel } from './support/fixture-datamodel.js';

type Model = AuditSchema['models'][number];
type Field = Model['fields'][number];
type Column = Extract<Field, { kind: 'scalar' | 'enum' | 'unsupported' }>;
type Relation = Extract<Field, { kind: 'object' }>;

const column = (name: string, type: string, overrides: Partial<Column> = {}): Column => ({
  name,
  kind: 'scalar',
  type,
  isList: false,
  isRequired: true,
  isId: false,
  isUnique: false,
  isUpdatedAt: false,
  hasDefaultValue: false,
  default: null,
  ...overrides,
});

const relation = (
  name: string,
  relatedModel: string,
  relationName: string,
  overrides: Partial<Relation> = {},
): Relation => ({
  name,
  kind: 'object',
  relatedModel,
  isList: false,
  isRequired: true,
  relationName,
  foreignKeyFields: [],
  referencedFields: [],
  ...overrides,
});

const author: Model = {
  name: 'Author',
  fields: [
    column('id', 'String', { isId: true, hasDefaultValue: true, default: { name: 'uuid', args: [7] } }),
    column('email', 'String', { isUnique: true }),
    column('name', 'String', { isRequired: false }),
    column('role', 'Role', { kind: 'enum', hasDefaultValue: true }),
    column('nicknames', 'String', { isList: true }),
    column('score', 'Int', { hasDefaultValue: true }),
    column('createdAt', 'DateTime', { hasDefaultValue: true, default: { name: 'now', args: [] } }),
    column('updatedAt', 'DateTime', { isUpdatedAt: true }),
    relation('profile', 'Profile', 'AuthorToProfile', { isRequired: false }),
    relation('authoredPosts', 'Post', 'PostAuthor', { isList: true }),
    relation('editedPosts', 'Post', 'PostEditor', { isList: true }),
    relation('likes', 'PostLike', 'AuthorToPostLike', { isList: true }),
    relation('bookmarks', 'PostBookmark', 'AuthorToPostBookmark', { isList: true }),
  ],
  primaryKey: { fields: ['id'], name: null },
  uniqueConstraints: [{ type: 'uniqueField', fields: ['email'], name: null }],
};

const profile: Model = {
  name: 'Profile',
  fields: [
    column('id', 'String', { isId: true, hasDefaultValue: true, default: { name: 'uuid', args: [4] } }),
    column('bio', 'String', { isRequired: false }),
    column('authorId', 'String', { isUnique: true }),
    relation('author', 'Author', 'AuthorToProfile', {
      foreignKeyFields: ['authorId'],
      referencedFields: ['id'],
    }),
  ],
  primaryKey: { fields: ['id'], name: null },
  uniqueConstraints: [{ type: 'uniqueField', fields: ['authorId'], name: null }],
};

const post: Model = {
  name: 'Post',
  fields: [
    column('id', 'String', { isId: true, hasDefaultValue: true, default: { name: 'cuid', args: [1] } }),
    column('title', 'String'),
    column('views', 'BigInt', { hasDefaultValue: true }),
    column('price', 'Decimal'),
    column('publishedAt', 'DateTime', { isRequired: false }),
    column('authorId', 'String'),
    column('editorId', 'String', { isRequired: false }),
    relation('author', 'Author', 'PostAuthor', { foreignKeyFields: ['authorId'], referencedFields: ['id'] }),
    relation('editor', 'Author', 'PostEditor', {
      isRequired: false,
      foreignKeyFields: ['editorId'],
      referencedFields: ['id'],
    }),
    relation('categories', 'Category', 'CategoryToPost', { isList: true }),
    relation('likes', 'PostLike', 'PostToPostLike', { isList: true }),
    relation('bookmarks', 'PostBookmark', 'PostToPostBookmark', { isList: true }),
  ],
  primaryKey: { fields: ['id'], name: null },
  uniqueConstraints: [{ type: 'uniqueIndex', fields: ['authorId', 'title'], name: null }],
};

const category: Model = {
  name: 'Category',
  fields: [
    column('id', 'Int', { isId: true, hasDefaultValue: true, default: { name: 'autoincrement', args: [] } }),
    column('name', 'String', { isUnique: true }),
    column('parentId', 'Int', { isRequired: false }),
    relation('parent', 'Category', 'CategoryTree', {
      isRequired: false,
      foreignKeyFields: ['parentId'],
      referencedFields: ['id'],
    }),
    relation('children', 'Category', 'CategoryTree', { isList: true }),
    relation('posts', 'Post', 'CategoryToPost', { isList: true }),
  ],
  primaryKey: { fields: ['id'], name: null },
  uniqueConstraints: [{ type: 'uniqueField', fields: ['name'], name: null }],
};

const postLike: Model = {
  name: 'PostLike',
  fields: [
    column('postId', 'String'),
    column('userId', 'String'),
    relation('post', 'Post', 'PostToPostLike', { foreignKeyFields: ['postId'], referencedFields: ['id'] }),
    relation('user', 'Author', 'AuthorToPostLike', { foreignKeyFields: ['userId'], referencedFields: ['id'] }),
  ],
  primaryKey: { fields: ['postId', 'userId'], name: null },
  uniqueConstraints: [],
};

const postBookmark: Model = {
  name: 'PostBookmark',
  fields: [
    column('postId', 'String'),
    column('userId', 'String'),
    column('label', 'String', { isRequired: false }),
    relation('post', 'Post', 'PostToPostBookmark', { foreignKeyFields: ['postId'], referencedFields: ['id'] }),
    relation('user', 'Author', 'AuthorToPostBookmark', { foreignKeyFields: ['userId'], referencedFields: ['id'] }),
  ],
  primaryKey: { fields: ['postId', 'userId'], name: 'bookmarkKey' },
  uniqueConstraints: [],
};

const device: Model = {
  name: 'Device',
  fields: [
    column('serial', 'String', { isUnique: true }),
    column('vendor', 'String'),
    column('model', 'String'),
    column('imei', 'String'),
  ],
  primaryKey: null,
  uniqueConstraints: [
    { type: 'uniqueField', fields: ['serial'], name: null },
    { type: 'uniqueIndex', fields: ['vendor', 'model'], name: null },
    { type: 'uniqueIndex', fields: ['vendor', 'imei'], name: 'vendorImei' },
  ],
};

const apiToken: Model = {
  name: 'ApiToken',
  fields: [column('id', 'String', { isId: true, hasDefaultValue: true, default: { name: 'cuid', args: [2] } })],
  primaryKey: { fields: ['id'], name: null },
  uniqueConstraints: [],
};

const legacyEvent: Model = {
  name: 'LegacyEvent',
  fields: [
    column('id', 'String', {
      isId: true,
      hasDefaultValue: true,
      default: { name: 'dbgenerated', args: ['gen_random_uuid()'] },
    }),
    column('payload', 'String', { hasDefaultValue: true }),
  ],
  primaryKey: { fields: ['id'], name: null },
  uniqueConstraints: [],
};

describe('toAuditSchema', () => {
  let schema: AuditSchema;

  beforeAll(async () => {
    schema = toAuditSchema(await loadFixtureDatamodel());
  });

  const modelOf = (name: string): Model | undefined => schema.models.find((m) => m.name === name);

  it('carries the format version and the models in declaration order under their declared names', () => {
    expect(schema.formatVersion).toBe(1);
    expect(schema.models.map((m) => m.name)).toStrictEqual([
      'Author',
      'Profile',
      'Post',
      'Category',
      'PostLike',
      'PostBookmark',
      'Device',
      'ApiToken',
      'LegacyEvent',
    ]);
  });

  it('keeps a mapped model under its Prisma name and its mapped fields under theirs', () => {
    expect(modelOf('Author')?.fields.map((f) => f.name)).toContain('createdAt');
    expect(modelOf('authors')).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('created_at');
  });

  it('describes a model with a single @id, a @unique field, enum and list fields, and a function default', () => {
    expect(modelOf('Author')).toStrictEqual(author);
  });

  it('describes the owning side of a 1:1 with its foreign key and the referenced field', () => {
    expect(modelOf('Profile')).toStrictEqual(profile);
  });

  it('describes a composite @@unique, an optional foreign key and an implicit many-to-many', () => {
    expect(modelOf('Post')).toStrictEqual(post);
  });

  it('describes a self relation from both sides', () => {
    expect(modelOf('Category')).toStrictEqual(category);
  });

  it('gives a composite @@id as the primary key with a null name', () => {
    expect(modelOf('PostLike')).toStrictEqual(postLike);
  });

  it('gives a named @@id as the primary key with that name', () => {
    expect(modelOf('PostBookmark')).toStrictEqual(postBookmark);
  });

  it('gives a model without a primary key a null primary key and its uniques, @unique fields first', () => {
    expect(modelOf('Device')).toStrictEqual(device);
  });

  it('keeps cuid(2) as a function default with its argument', () => {
    expect(modelOf('ApiToken')).toStrictEqual(apiToken);
  });

  it('keeps dbgenerated() as a function default with its expression, and a literal default as hasDefaultValue only', () => {
    expect(modelOf('LegacyEvent')).toStrictEqual(legacyEvent);
  });

  it('rejects a relation field that has no relation name', async () => {
    const datamodel = await loadFixtureDatamodel();
    const withoutRelationName: DMMF.Datamodel = {
      ...datamodel,
      models: datamodel.models.map((model) =>
        model.name === 'Profile'
          ? {
              ...model,
              fields: model.fields.map((field) =>
                field.name === 'author' ? { ...field, relationName: undefined } : field,
              ),
            }
          : model,
      ),
    };

    expect(() => toAuditSchema(withoutRelationName)).toThrow('Profile.author');
  });
});
