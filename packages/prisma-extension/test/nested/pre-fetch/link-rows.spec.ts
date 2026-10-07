/**
 * Tests for the rows a nested link write may re-link: where a relation's foreign key lives, which
 * writes re-link rows, and the read made for them before the write
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import type { DMMFField, DMMFModel, PrismaNamespace } from '../../../src/internal-types.js';
import { detectExecutedNestedOperations } from '../../../src/nested/events/write-set.js';
import { linkWriteOf, type ReadLinkRowsDependencies, readLinkRows } from '../../../src/nested/pre-fetch/link-rows.js';
import { storeReadResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import {
  findBackRelationField,
  relationLinkOf,
  resolveRelationLink,
} from '../../../src/nested/pre-fetch/relation-link.js';
import type { RelationField } from '../../../src/schema/types.js';
import { NO_AUDITED_OMITTED_FIELDS } from '../../../src/utils/audited-omitted-fields.js';
import { createSchemaMetadataFromDMMF } from '../../../src/utils/schema-metadata.js';

const scalar = (name: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'scalar',
  type: 'String',
  ...extra,
});
const relation = (name: string, type: string, relationName: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'object',
  type,
  relationName,
  ...extra,
});

const models: DMMFModel[] = [
  {
    name: 'User',
    fields: [scalar('id', { isId: true }), relation('posts', 'Post', 'PostToUser', { isList: true })],
  },
  {
    name: 'Post',
    fields: [
      scalar('id', { isId: true }),
      scalar('authorId'),
      relation('author', 'User', 'PostToUser', {
        isRequired: true,
        relationFromFields: ['authorId'],
        relationToFields: ['id'],
      }),
      relation('labels', 'Label', 'LabelToPost', { isList: true }),
      relation('categories', 'Category', 'CategoryToPost', { isList: true }),
    ],
  },
  {
    name: 'Label',
    fields: [
      scalar('id', { isId: true }),
      scalar('postId'),
      relation('post', 'Post', 'LabelToPost', {
        isRequired: false,
        relationFromFields: ['postId'],
        relationToFields: ['id'],
      }),
    ],
  },
  {
    name: 'Category',
    fields: [scalar('id', { isId: true }), relation('posts', 'Post', 'CategoryToPost', { isList: true })],
  },
];

const Prisma: PrismaNamespace = { defineExtension: () => undefined, DbNull: null, dmmf: { datamodel: { models } } };
const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
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
  const nodeFields = createSchemaMetadataFromDMMF({
    dmmf: {
      datamodel: {
        models: [
          {
            name: 'Node',
            fields: [
              scalar('id', { isId: true }),
              scalar('parentId'),
              relation('children', 'Node', 'Tree', { isList: true }),
              relation('parent', 'Node', 'Tree', { relationFromFields: ['parentId'], relationToFields: ['id'] }),
            ],
          },
        ],
      },
    },
  }).getRelationFields('Node');
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

describe('linkWriteOf', () => {
  const optional = {
    side: 'related',
    parentModel: 'Post',
    fields: ['postId'],
    references: ['id'],
    optional: true,
  } as const;
  const required = { ...optional, optional: false } as const;
  const operation = (
    keyword: 'connect' | 'set' | 'disconnect' | 'create' | 'connectOrCreate',
    data: unknown,
    isList = true,
  ) => ({
    fieldName: 'labels',
    precedingWrites: [],
    relatedModel: 'Label',
    operation: keyword,
    isList,
    data,
    path: 'labels',
  });

  it('names the rows a connect attaches', () => {
    const connect = operation('connect', [{ id: 'l1' }]);
    expect(linkWriteOf(connect, optional)).toEqual({ operation: connect, named: [{ id: 'l1' }], detaches: false });
  });

  it('detaches the rows attached under the parent for a set on an optional foreign key only', () => {
    expect(linkWriteOf(operation('set', [{ id: 'l1' }]), optional)?.detaches).toBe(true);
    expect(linkWriteOf(operation('set', [{ id: 'l1' }]), required)?.detaches).toBe(false);
  });

  it('names the rows a to-many disconnect detaches', () => {
    expect(linkWriteOf(operation('disconnect', { id: 'l1' }), optional)).toMatchObject({
      named: [{ id: 'l1' }],
      detaches: false,
    });
  });

  it('detaches the row the parent held for a to-one connect, create or disconnect on an optional foreign key', () => {
    expect(linkWriteOf(operation('connect', { id: 'l1' }, false), optional)).toMatchObject({
      named: [{ id: 'l1' }],
      detaches: true,
    });
    expect(linkWriteOf(operation('create', { name: 'n' }, false), optional)).toMatchObject({
      named: [],
      detaches: true,
    });
    expect(linkWriteOf(operation('disconnect', true, false), optional)).toMatchObject({ named: [], detaches: true });
  });

  it('detaches nothing for a to-one write on a required foreign key, which Prisma rejects when it would', () => {
    expect(linkWriteOf(operation('connect', { id: 'l1' }, false), required)?.detaches).toBe(false);
    expect(linkWriteOf(operation('create', { name: 'n' }, false), required)).toBeUndefined();
    expect(linkWriteOf(operation('disconnect', true, false), required)).toBeUndefined();
  });

  it('names no row for a connectOrCreate, which a read of its own already covers, and detaches the row a to-one one replaces on an optional foreign key only', () => {
    const data = { where: { id: 'l1' }, create: { id: 'l1' } };

    expect(linkWriteOf(operation('connectOrCreate', data), optional)).toMatchObject({ named: [], detaches: false });
    expect(linkWriteOf(operation('connectOrCreate', data, false), optional)).toMatchObject({
      named: [],
      detaches: true,
    });
    expect(linkWriteOf(operation('connectOrCreate', data, false), required)).toMatchObject({
      named: [],
      detaches: false,
    });
  });

  it('is no link write for a to-many create', () => {
    expect(linkWriteOf(operation('create', { name: 'n' }), optional)).toBeUndefined();
  });
});

describe('readLinkRows', () => {
  const twoParents = (): NestedPreFetchResults => {
    const results: NestedPreFetchResults = new Map();
    const pk = { type: 'primaryKey' as const, fields: ['id'] };
    storeReadResult(results, 'posts', { id: 'p1' }, { id: 'p1', authorId: 'u1' }, pk);
    storeReadResult(results, 'posts', { id: 'p2' }, { id: 'p2', authorId: 'u1' }, pk);
    return results;
  };
  const args = {
    where: { id: 'u1' },
    data: {
      posts: {
        update: [
          { where: { id: 'p1' }, data: { labels: { set: [{ id: 'la' }] } } },
          { where: { id: 'p2' }, data: { labels: { connect: { id: 'lb' } } } },
        ],
      },
    },
  };

  /** Reads the link rows of `args` through `findMany`, with every dependency but the ones given at their defaults */
  const readWith = (
    findMany: (query: unknown) => Promise<Record<string, unknown>[]>,
    deps: Partial<ReadLinkRowsDependencies> = {},
  ) => {
    const nestedPreFetchResults = twoParents();
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      'User',
      args,
      undefined,
      nestedPreFetchResults,
    );
    return readLinkRows(
      {
        prismaClient: { label: { findMany } },
        modelName: 'User',
        topLevelWhere: args.where,
        nestedOperations,
        nestedPreFetchResults,
      },
      {
        schemaMetadata,
        auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
        shouldFetchBefore: () => true,
        ...deps,
      },
    );
  };

  it('reads the rows of every link write at a path in one query, named rows and rows attached under the parents', async () => {
    const findMany = vi.fn(async () => [{ id: 'la', postId: 'p9' }]);

    const reads = await readWith(findMany);

    expect(findMany.mock.calls).toEqual([[{ where: { OR: [{ id: 'la' }, { postId: 'p1' }, { id: 'lb' }] } }]]);
    expect(reads.get('posts.labels')).toMatchObject({ rows: [{ id: 'la', postId: 'p9' }], failed: false });
  });

  it('reads nothing when the before state of updates of the related model is not read', async () => {
    const findMany = vi.fn();

    const reads = await readWith(findMany, { shouldFetchBefore: (model) => model !== 'Label' });

    expect(findMany).not.toHaveBeenCalled();
    expect(reads.size).toBe(0);
  });

  it('reports a link whose foreign key references no field of the parent model instead of reading every row', async () => {
    const withoutReferences: DMMFModel[] = models.map((model) =>
      model.name === 'Label'
        ? {
            ...model,
            fields: model.fields.map((field) => (field.name === 'post' ? { ...field, relationToFields: [] } : field)),
          }
        : model,
    );
    const unresolved: PrismaNamespace = {
      defineExtension: () => undefined,
      DbNull: null,
      dmmf: { datamodel: { models: withoutReferences } },
    };
    const findMany = vi.fn(async () => []);
    const onPreFetchFailure = vi.fn(async () => undefined);

    const reads = await readWith(findMany, {
      schemaMetadata: createSchemaMetadataFromDMMF(unresolved),
      onPreFetchFailure,
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(reads.get('posts.labels')).toMatchObject({ rows: [], failed: true });
    expect(onPreFetchFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'pre-fetch',
        modelName: 'Label',
        error: expect.objectContaining({ message: expect.stringContaining('"postId"') }),
      }),
    );
  });

  it('reports a failed read and marks the path', async () => {
    const error = new Error('findMany failed');
    const onPreFetchFailure = vi.fn(async () => undefined);
    const findMany = vi.fn(async () => {
      throw error;
    });

    const reads = await readWith(findMany, { onPreFetchFailure });

    expect(reads.get('posts.labels')).toMatchObject({ rows: [], failed: true });
    expect(onPreFetchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pre-fetch', modelName: 'Label', operation: 'set', error }),
    );
  });
});
