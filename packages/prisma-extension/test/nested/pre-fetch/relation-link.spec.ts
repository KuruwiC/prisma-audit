/**
 * Tests for where a relation's foreign key lives, and for finding the field that holds the other side of a relation
 */

import { describe, expect, it } from 'vitest';
import {
  findBackRelationField,
  relationLinkOf,
  resolveRelationLink,
} from '../../../src/nested/pre-fetch/relation-link.js';
import type { RelationField } from '../../../src/schema/types.js';
import { column, model, relation, schemaMetadataOf } from '../../support/audit-schema.js';

const models = [
  model('User', [column('id', { isId: true }), relation('posts', 'Post', 'PostToUser', { isList: true })]),
  model('Post', [
    column('id', { isId: true }),
    column('slug', { isUnique: true }),
    column('authorId'),
    relation('author', 'User', 'PostToUser', {
      isRequired: true,
      foreignKeyFields: ['authorId'],
      referencedFields: ['id'],
    }),
    relation('labels', 'Label', 'LabelToPost', { isList: true }),
    relation('categories', 'Category', 'CategoryToPost', { isList: true }),
  ]),
  model('Label', [
    column('id', { isId: true }),
    column('postId'),
    relation('post', 'Post', 'LabelToPost', {
      isRequired: false,
      foreignKeyFields: ['postId'],
      referencedFields: ['id'],
    }),
  ]),
  model('Category', [column('id', { isId: true }), relation('posts', 'Post', 'CategoryToPost', { isList: true })]),
];

const schemaMetadata = schemaMetadataOf(...models);
const at = (path: string, fieldName: string, relatedModel: string) => ({ path, fieldName, relatedModel });

describe('relationLinkOf', () => {
  it('finds an optional foreign key on the related model', () => {
    expect(relationLinkOf(schemaMetadata, 'Post', at('labels', 'labels', 'Label'))).toEqual({
      side: 'related',
      parentModel: 'Post',
      fields: ['postId'],
      references: ['id'],
      optional: true,
    });
  });

  it('finds a required foreign key on the related model', () => {
    expect(relationLinkOf(schemaMetadata, 'User', at('posts', 'posts', 'Post'))).toMatchObject({
      side: 'related',
      optional: false,
    });
  });

  it("tells a foreign key on the parent row and an implicit many-to-many relation's join table", () => {
    expect(relationLinkOf(schemaMetadata, 'Post', at('author', 'author', 'User'))).toEqual({ side: 'parent' });
    expect(relationLinkOf(schemaMetadata, 'Post', at('categories', 'categories', 'Category'))).toEqual({
      side: 'joinTable',
    });
  });

  it('finds nothing for a field without a back-relation', () => {
    const orphans: RelationField = {
      name: 'orphans',
      relatedModel: 'Label',
      isList: true,
      isRequired: false,
      relationName: 'Orphan',
      foreignKeyFields: [],
      referencedFields: [],
    };

    expect(resolveRelationLink(orphans, 'Post', 'Label', [])).toBe(undefined);
  });
});

describe('findBackRelationField', () => {
  const nodeFields = schemaMetadataOf(
    model('Node', [
      column('id', { isId: true }),
      column('parentId'),
      relation('children', 'Node', 'Tree', { isList: true }),
      relation('parent', 'Node', 'Tree', { foreignKeyFields: ['parentId'], referencedFields: ['id'] }),
    ]),
  ).getRelationFields('Node');
  const children = nodeFields.find((field) => field.name === 'children') as RelationField;
  const parent = nodeFields.find((field) => field.name === 'parent') as RelationField;

  it('finds the other side of a self-relation, not the field itself', () => {
    expect(findBackRelationField(children, 'Node', 'Node', nodeFields)).toBe(parent);
    expect(findBackRelationField(parent, 'Node', 'Node', nodeFields)).toBe(children);
  });

  it('finds the field of the related model that carries the same relation name', () => {
    const labelFields = schemaMetadata.getRelationFields('Label');
    const labelPost = labelFields.find((field) => field.name === 'post');
    const postLabels = schemaMetadata.getRelationFields('Post').find((field) => field.name === 'labels');

    expect(findBackRelationField(postLabels as RelationField, 'Post', 'Label', labelFields)).toBe(labelPost);
  });

  it('finds nothing when no field of the related model carries the relation name', () => {
    expect(findBackRelationField(children, 'Node', 'Node', [children])).toBeUndefined();
  });
});
