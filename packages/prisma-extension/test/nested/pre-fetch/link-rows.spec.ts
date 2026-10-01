/**
 * Tests for the rows a nested link write may re-link: where a relation's foreign key lives, which
 * writes re-link rows, and the read made for them before the write
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import type { DMMFField, DMMFModel, PrismaNamespace } from '../../../src/internal-types.js';
import { detectExecutedNestedOperations } from '../../../src/nested/events/write-set.js';
import { linkWriteOf, readLinkRows } from '../../../src/nested/pre-fetch/link-rows.js';
import { storeReadResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { relationLinkOf, resolveRelationLink } from '../../../src/nested/pre-fetch/relation-link.js';
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
    expect(relationLinkOf(Prisma, 'Post', at('labels', 'labels', 'Label'))).toEqual({
      side: 'related',
      parentModel: 'Post',
      fields: ['postId'],
      references: ['id'],
      optional: true,
    });
  });

  it('finds a required foreign key on the related model', () => {
    expect(relationLinkOf(Prisma, 'User', at('posts', 'posts', 'Post'))).toMatchObject({
      side: 'related',
      optional: false,
    });
  });

  it("tells a foreign key on the parent row and an implicit many-to-many relation's join table", () => {
    expect(relationLinkOf(Prisma, 'Post', at('author', 'author', 'User'))).toEqual({ side: 'parent' });
    expect(relationLinkOf(Prisma, 'Post', at('categories', 'categories', 'Category'))).toEqual({ side: 'joinTable' });
  });

  it('finds nothing for a field without a back-relation', () => {
    expect(resolveRelationLink(relation('orphans', 'Label', 'Orphan', { isList: true }), 'Post', 'Label', [])).toBe(
      undefined,
    );
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
  const operation = (keyword: 'connect' | 'set' | 'disconnect' | 'create', data: unknown, isList = true) => ({
    fieldName: 'labels',
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

  it('reads the rows of every link write at a path in one query, named rows and rows attached under the parents', async () => {
    const nestedPreFetchResults = twoParents();
    const findMany = vi.fn(async () => [{ id: 'la', postId: 'p9' }]);
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      'User',
      args,
      undefined,
      nestedPreFetchResults,
    );

    const reads = await readLinkRows(
      {
        prismaClient: { label: { findMany } },
        modelName: 'User',
        topLevelWhere: args.where,
        nestedOperations,
        nestedPreFetchResults,
      },
      { Prisma, schemaMetadata, shouldFetchBefore: () => true },
    );

    expect(findMany.mock.calls).toEqual([[{ where: { OR: [{ id: 'la' }, { postId: 'p1' }, { id: 'lb' }] } }]]);
    expect(reads.get('posts.labels')).toMatchObject({ rows: [{ id: 'la', postId: 'p9' }], failed: false });
  });

  it('reads nothing when the before state of updates of the related model is not read', async () => {
    const nestedPreFetchResults = twoParents();
    const findMany = vi.fn();
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      'User',
      args,
      undefined,
      nestedPreFetchResults,
    );

    const reads = await readLinkRows(
      {
        prismaClient: { label: { findMany } },
        modelName: 'User',
        topLevelWhere: args.where,
        nestedOperations,
        nestedPreFetchResults,
      },
      { Prisma, schemaMetadata, shouldFetchBefore: (model) => model !== 'Label' },
    );

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
    const nestedPreFetchResults = twoParents();
    const findMany = vi.fn(async () => []);
    const onPreFetchFailure = vi.fn(async () => undefined);
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      'User',
      args,
      undefined,
      nestedPreFetchResults,
    );

    const reads = await readLinkRows(
      {
        prismaClient: { label: { findMany } },
        modelName: 'User',
        topLevelWhere: args.where,
        nestedOperations,
        nestedPreFetchResults,
      },
      { Prisma: unresolved, schemaMetadata, shouldFetchBefore: () => true, onPreFetchFailure },
    );

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
    const nestedPreFetchResults = twoParents();
    const error = new Error('findMany failed');
    const onPreFetchFailure = vi.fn(async () => undefined);
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      'User',
      args,
      undefined,
      nestedPreFetchResults,
    );

    const reads = await readLinkRows(
      {
        prismaClient: {
          label: {
            findMany: vi.fn(async () => {
              throw error;
            }),
          },
        },
        modelName: 'User',
        topLevelWhere: args.where,
        nestedOperations,
        nestedPreFetchResults,
      },
      { Prisma, schemaMetadata, shouldFetchBefore: () => true, onPreFetchFailure },
    );

    expect(reads.get('posts.labels')).toMatchObject({ rows: [], failed: true });
    expect(onPreFetchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pre-fetch', modelName: 'Label', operation: 'set', error }),
    );
  });
});
