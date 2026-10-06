import { describe, expect, it } from 'vitest';

import type { DMMFModel } from '../../src/internal-types.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';

const createPrismaWithModel = (model: Partial<DMMFModel> & { name: string; fields: DMMFModel['fields'] }) => ({
  dmmf: { datamodel: { models: [model] as DMMFModel[] } },
});

describe('createSchemaMetadataFromDMMF', () => {
  describe('getUniqueConstraints', () => {
    it('should return composite primary key', () => {
      const Prisma = createPrismaWithModel({
        name: 'PostTag',
        fields: [
          { name: 'postId', kind: 'scalar', type: 'String' },
          { name: 'tagId', kind: 'scalar', type: 'String' },
        ],
        primaryKey: { name: 'postId_tagId', fields: ['postId', 'tagId'] },
      });

      const metadata = createSchemaMetadataFromDMMF(Prisma);
      const constraints = metadata.getUniqueConstraints('PostTag');

      expect(constraints).toEqual([{ type: 'primaryKey', fields: ['postId', 'tagId'], name: 'postId_tagId' }]);
    });

    it('should return unique fields', () => {
      const Prisma = createPrismaWithModel({
        name: 'User',
        fields: [
          { name: 'id', kind: 'scalar', type: 'String', isId: true },
          { name: 'email', kind: 'scalar', type: 'String', isUnique: true },
        ],
      });

      const metadata = createSchemaMetadataFromDMMF(Prisma);
      const constraints = metadata.getUniqueConstraints('User');

      expect(constraints).toContainEqual({ type: 'uniqueField', fields: ['email'] });
    });

    it('should return unique indexes after unique fields', () => {
      const Prisma = createPrismaWithModel({
        name: 'Article',
        fields: [
          { name: 'id', kind: 'scalar', type: 'String', isId: true },
          { name: 'tenantId', kind: 'scalar', type: 'String' },
          { name: 'slug', kind: 'scalar', type: 'String', isUnique: true },
        ],
        uniqueIndexes: [{ name: 'tenant_slug', fields: ['tenantId', 'slug'] }],
      });

      const metadata = createSchemaMetadataFromDMMF(Prisma);

      expect(metadata.getUniqueConstraints('Article')).toEqual([
        { type: 'uniqueField', fields: ['slug'] },
        { type: 'uniqueIndex', fields: ['tenantId', 'slug'], name: 'tenant_slug' },
      ]);
    });

    it('should return empty for unknown model', () => {
      const Prisma = createPrismaWithModel({ name: 'User', fields: [] });
      const metadata = createSchemaMetadataFromDMMF(Prisma);
      expect(metadata.getUniqueConstraints('Unknown')).toEqual([]);
    });

    it('should return empty when Prisma carries no DMMF', () => {
      expect(createSchemaMetadataFromDMMF({}).getUniqueConstraints('User')).toEqual([]);
    });
  });

  describe('getAllFields', () => {
    it('should return all fields with metadata', () => {
      const Prisma = createPrismaWithModel({
        name: 'User',
        fields: [
          { name: 'id', kind: 'scalar', type: 'String', isId: true },
          { name: 'email', kind: 'scalar', type: 'String', isUnique: true },
        ],
      });

      const metadata = createSchemaMetadataFromDMMF(Prisma);
      const fields = metadata.getAllFields('User');

      expect(fields).toHaveLength(2);
      expect(fields[0]).toMatchObject({ name: 'id', isId: true });
      expect(fields[1]).toMatchObject({ name: 'email', isUnique: true });
    });

    it('should report hasDefaultValue for a field with a default and no hasDefaultValue flag', () => {
      const Prisma = createPrismaWithModel({
        name: 'User',
        fields: [
          { name: 'role', kind: 'scalar', type: 'String', default: 'member' },
          { name: 'name', kind: 'scalar', type: 'String' },
        ],
      });

      const fields = createSchemaMetadataFromDMMF(Prisma).getAllFields('User');

      expect(fields.map(({ name, hasDefaultValue }) => ({ name, hasDefaultValue }))).toEqual([
        { name: 'role', hasDefaultValue: true },
        { name: 'name', hasDefaultValue: false },
      ]);
    });

    it('should return empty for unknown model', () => {
      const Prisma = createPrismaWithModel({ name: 'User', fields: [{ name: 'id', kind: 'scalar', type: 'String' }] });
      expect(createSchemaMetadataFromDMMF(Prisma).getAllFields('Unknown')).toEqual([]);
    });
  });

  describe('getRelationFields', () => {
    it('should return only relation fields (kind === "object") with their relation metadata', () => {
      const Prisma = createPrismaWithModel({
        name: 'User',
        fields: [
          { name: 'id', kind: 'scalar', type: 'String', isList: false },
          { name: 'email', kind: 'scalar', type: 'String', isList: false },
          { name: 'metadata', kind: 'scalar', type: 'Json', isList: false },
          { name: 'posts', kind: 'object', type: 'Post', isList: true, relationName: 'UserPosts' },
          { name: 'profile', kind: 'object', type: 'Profile', isList: false, relationName: 'UserProfile' },
        ],
      });

      expect(createSchemaMetadataFromDMMF(Prisma).getRelationFields('User')).toEqual([
        { name: 'posts', relatedModel: 'Post', isList: true, isRequired: false, relationName: 'UserPosts' },
        { name: 'profile', relatedModel: 'Profile', isList: false, isRequired: false, relationName: 'UserProfile' },
      ]);
    });

    it('should return empty when Prisma carries no DMMF', () => {
      expect(createSchemaMetadataFromDMMF({}).getRelationFields('User')).toEqual([]);
    });

    it('should return empty for unknown model', () => {
      const Prisma = createPrismaWithModel({
        name: 'User',
        fields: [{ name: 'posts', kind: 'object', type: 'Post', isList: true }],
      });
      expect(createSchemaMetadataFromDMMF(Prisma).getRelationFields('Unknown')).toEqual([]);
    });
  });
});
