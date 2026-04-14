import { describe, expect, it } from 'vitest';

import type { DMMFModel } from '../src/internal-types.js';
import { createSchemaMetadataFromDMMF, getUniqueConstraints } from '../src/utils/schema-metadata.js';

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

    it('should return empty for unknown model', () => {
      const Prisma = createPrismaWithModel({ name: 'User', fields: [] });
      const metadata = createSchemaMetadataFromDMMF(Prisma);
      expect(metadata.getUniqueConstraints('Unknown')).toEqual([]);
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
  });

  describe('getRelationFields', () => {
    it('should return relation fields', () => {
      const Prisma = createPrismaWithModel({
        name: 'User',
        fields: [
          { name: 'id', kind: 'scalar', type: 'String' },
          { name: 'posts', kind: 'object', type: 'Post', isList: true },
        ],
      });

      const metadata = createSchemaMetadataFromDMMF(Prisma);
      const relations = metadata.getRelationFields('User');

      expect(relations).toHaveLength(1);
      expect(relations[0]).toMatchObject({ name: 'posts', relatedModel: 'Post', isList: true });
    });
  });
});

describe('getUniqueConstraints (standalone)', () => {
  it('should delegate to createSchemaMetadataFromDMMF', () => {
    const Prisma = createPrismaWithModel({
      name: 'User',
      fields: [{ name: 'email', kind: 'scalar', type: 'String', isUnique: true }],
    });

    const constraints = getUniqueConstraints(Prisma, 'User');
    expect(constraints).toContainEqual({ type: 'uniqueField', fields: ['email'] });
  });

  it('should return empty for missing DMMF', () => {
    expect(getUniqueConstraints({}, 'User')).toEqual([]);
  });
});
