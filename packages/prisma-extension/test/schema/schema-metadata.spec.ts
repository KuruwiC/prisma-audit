/**
 * The schema metadata the extension reads every model's structure from, built from the audit schema
 */

import { describe, expect, it } from 'vitest';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

const UNKNOWN_MODEL_MESSAGE =
  '[@prisma-audit] Model "Unknown" is not in the audit schema passed as "schema"; pass the schema generated from ' +
  'the same schema.prisma as the client.';

describe('loadSchemaMetadata', () => {
  describe('getModelNames', () => {
    it('should return the model names in schema order', () => {
      const metadata = schemaMetadataOf(model('User', []), model('Post', []), model('AuditLog', []));

      expect(metadata.getModelNames()).toEqual(['User', 'Post', 'AuditLog']);
    });
  });

  describe('getUniqueConstraints', () => {
    it('should return composite primary key', () => {
      const metadata = schemaMetadataOf(
        model('PostTag', [column('postId'), column('tagId')], {
          primaryKey: { name: 'postId_tagId', fields: ['postId', 'tagId'] },
        }),
      );

      expect(metadata.getUniqueConstraints('PostTag')).toEqual([
        { type: 'primaryKey', fields: ['postId', 'tagId'], name: 'postId_tagId' },
      ]);
    });

    it('should return the @id field as the primary key, ahead of unique fields', () => {
      const metadata = schemaMetadataOf(
        model('User', [column('id', { isId: true }), column('email', { isUnique: true })]),
      );

      expect(metadata.getUniqueConstraints('User')).toEqual([
        { type: 'primaryKey', fields: ['id'], name: null },
        { type: 'uniqueField', fields: ['email'], name: null },
      ]);
    });

    it('should return unique indexes after unique fields', () => {
      const metadata = schemaMetadataOf(
        model('Article', [column('tenantId'), column('slug', { isUnique: true })], {
          uniqueIndexes: [{ name: 'tenant_slug', fields: ['tenantId', 'slug'] }],
        }),
      );

      expect(metadata.getUniqueConstraints('Article')).toEqual([
        { type: 'uniqueField', fields: ['slug'], name: null },
        { type: 'uniqueIndex', fields: ['tenantId', 'slug'], name: 'tenant_slug' },
      ]);
    });

    it('throws naming a model the schema does not hold', () => {
      expect(() => schemaMetadataOf(model('User', [])).getUniqueConstraints('Unknown')).toThrow(UNKNOWN_MODEL_MESSAGE);
    });
  });

  describe('getAllFields', () => {
    it('should return all fields with metadata', () => {
      const metadata = schemaMetadataOf(
        model('User', [column('id', { isId: true }), column('email', { isUnique: true })]),
      );
      const fields = metadata.getAllFields('User');

      expect(fields).toHaveLength(2);
      expect(fields[0]).toMatchObject({ name: 'id', isId: true });
      expect(fields[1]).toMatchObject({ name: 'email', isUnique: true });
    });

    it('should describe a relation field by its related model', () => {
      const metadata = schemaMetadataOf(
        model('Post', [relation('author', 'User', 'UserPosts', { isRequired: true, foreignKeyFields: ['authorId'] })]),
      );

      expect(metadata.getAllFields('Post')).toEqual([
        {
          name: 'author',
          type: 'User',
          kind: 'object',
          isRequired: true,
          isUnique: false,
          isId: false,
          isList: false,
          hasDefaultValue: false,
          isUpdatedAt: false,
        },
      ]);
    });

    it('should carry a function default, and only hasDefaultValue for a literal one', () => {
      const metadata = schemaMetadataOf(
        model('User', [
          column('id', { hasDefaultValue: true, default: { name: 'uuid', args: [7] } }),
          column('role', { hasDefaultValue: true }),
          column('name'),
        ]),
      );

      expect(
        metadata.getAllFields('User').map(({ name, hasDefaultValue, default: fn }) => [name, hasDefaultValue, fn]),
      ).toEqual([
        ['id', true, { name: 'uuid', args: [7] }],
        ['role', true, undefined],
        ['name', false, undefined],
      ]);
    });

    it('throws naming a model the schema does not hold', () => {
      expect(() => schemaMetadataOf(model('User', [column('id')])).getAllFields('Unknown')).toThrow(
        UNKNOWN_MODEL_MESSAGE,
      );
    });
  });

  describe('getFieldMetadata', () => {
    it('should return the field of the model, and undefined for a field the model lacks', () => {
      const metadata = schemaMetadataOf(model('User', [column('updatedAt', { type: 'DateTime', isUpdatedAt: true })]));

      expect(metadata.getFieldMetadata('User', 'updatedAt')).toMatchObject({ type: 'DateTime', isUpdatedAt: true });
      expect(metadata.getFieldMetadata('User', 'missing')).toBeUndefined();
    });

    it('throws naming a model the schema does not hold', () => {
      expect(() => schemaMetadataOf(model('User', [column('id')])).getFieldMetadata('Unknown', 'id')).toThrow(
        UNKNOWN_MODEL_MESSAGE,
      );
    });
  });

  describe('getRelationFields', () => {
    it('should return the fields of the model that hold the foreign key of a relation it owns, and none for the other side', () => {
      const metadata = schemaMetadataOf(
        model('Membership', [
          column('orgId'),
          relation('org', 'Org', 'OrgMemberships', { foreignKeyFields: ['orgId'], referencedFields: ['id'] }),
          relation('notes', 'Note', 'MembershipNotes', { isList: true }),
        ]),
      );

      expect(
        metadata.getRelationFields('Membership').map(({ name, foreignKeyFields }) => [name, foreignKeyFields]),
      ).toEqual([
        ['org', ['orgId']],
        ['notes', []],
      ]);
    });

    it('should return the fields of the other model that the foreign key references, and none for the other side', () => {
      const metadata = schemaMetadataOf(
        model('Membership', [
          column('orgId'),
          column('orgSlug'),
          relation('org', 'Org', 'OrgMemberships', {
            foreignKeyFields: ['orgId', 'orgSlug'],
            referencedFields: ['id', 'slug'],
          }),
          relation('notes', 'Note', 'MembershipNotes', { isList: true }),
        ]),
      );

      expect(
        metadata.getRelationFields('Membership').map(({ name, referencedFields }) => [name, referencedFields]),
      ).toEqual([
        ['org', ['id', 'slug']],
        ['notes', []],
      ]);
    });

    it('should return only relation fields with their relation metadata', () => {
      const metadata = schemaMetadataOf(
        model('User', [
          column('id'),
          column('email'),
          column('metadata', { type: 'Json' }),
          relation('posts', 'Post', 'UserPosts', { isList: true }),
          relation('profile', 'Profile', 'UserProfile'),
        ]),
      );

      expect(metadata.getRelationFields('User')).toEqual([
        {
          name: 'posts',
          relatedModel: 'Post',
          isList: true,
          isRequired: false,
          relationName: 'UserPosts',
          foreignKeyFields: [],
          referencedFields: [],
        },
        {
          name: 'profile',
          relatedModel: 'Profile',
          isList: false,
          isRequired: false,
          relationName: 'UserProfile',
          foreignKeyFields: [],
          referencedFields: [],
        },
      ]);
    });

    it('throws naming a model the schema does not hold', () => {
      expect(() =>
        schemaMetadataOf(model('User', [relation('posts', 'Post', 'UserPosts', { isList: true })])).getRelationFields(
          'Unknown',
        ),
      ).toThrow(UNKNOWN_MODEL_MESSAGE);
    });
  });
});
