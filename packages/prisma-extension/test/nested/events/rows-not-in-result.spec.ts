/**
 * Tests for the rows an operation wrote at a to-many path that the result does not hold: rows
 * inserted under parent rows whose relation the caller restricted are returned for the parent row
 * they hang under only.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedOperationInfo } from '../../../src/grammar/nested-operations.js';
import {
  type ParentAtPath,
  type RowsNotInResultInput,
  readRowsNotInResult,
} from '../../../src/nested/events/rows-not-in-result.js';
import type { LocatedTarget } from '../../../src/nested/events/write-set.js';
import type { PreFetchListClient } from '../../../src/nested/pre-fetch/model-client.js';
import type { ToManyPath } from '../../../src/nested/pre-fetch/to-many-path.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { column, model, schemaMetadataOf } from '../../support/audit-schema.js';

type Row = Record<string, unknown>;

const schemaMetadata = schemaMetadataOf(
  model('Post', [column('id', { isId: true }), column('authorId'), column('slug')]),
  model('Category', [column('id', { isId: true }), column('name')]),
);

const pk: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };

const hiddenParent = (id: string): ParentAtPath => ({
  row: { id },
  rows: [],
  absentTargets: [],
  insertsHidden: true,
  isInserted: () => true,
});

const postUpdate: NestedOperationInfo = {
  fieldName: 'posts',
  precedingWrites: [],
  relatedModel: 'Post',
  operation: 'update',
  isList: true,
  data: [],
  path: 'posts',
};

const targetBy = (by: 'rowKey' | 'uniqueWhere', where: Row): LocatedTarget => ({
  locator: { by, where },
  operation: postUpdate,
  element: 0,
  before: { kind: 'none' },
});

/** A client that returns the primary keys of the rows under the parents, then those rows whole */
const clientReading = (keys: Row[], rows: Row[]) => {
  const findMany = vi.fn(async (args: { select?: Record<string, unknown> }) => (args.select ? keys : rows));
  return { client: { findMany } satisfies PreFetchListClient, findMany };
};

const inputOf = (
  client: PreFetchListClient,
  relatedModel: string,
  path: ToManyPath | undefined,
  parents: readonly ParentAtPath[],
): RowsNotInResultInput => ({
  client,
  schemaMetadata,
  relatedModel,
  path: 'rows',
  keyFields: ['id'],
  parents,
  resolvePath: () => path,
  include: undefined,
});

describe('readRowsNotInResult', () => {
  describe('rows inserted under parent rows whose relation the caller restricted', () => {
    it('returns each inserted row for the parent row whose key its foreign key holds', async () => {
      const path: ToManyPath = {
        parentModelName: 'User',
        parentKeyConstraint: pk,
        keyConstraint: pk,
        scope: {
          backField: 'author',
          filter: 'is',
          parentFields: ['id'],
          foreignKey: { fields: ['authorId'], references: ['id'] },
        },
      };
      const postA = { id: 'pa', authorId: 'u1' };
      const postB = { id: 'pb', authorId: 'u2' };
      const { client, findMany } = clientReading([{ id: 'pa' }, { id: 'pb' }], [postA, postB]);

      const rows = await readRowsNotInResult(inputOf(client, 'Post', path, [hiddenParent('u1'), hiddenParent('u2')]));

      expect(rows).toEqual([[postA], [postB]]);
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('returns each inserted row of an implicit many-to-many relation for the parent row it is linked to, without the link keys', async () => {
      const path: ToManyPath = {
        parentModelName: 'Post',
        parentKeyConstraint: pk,
        keyConstraint: pk,
        scope: { backField: 'posts', filter: 'some', parentFields: ['id'] },
      };
      const categoryA = { id: 'ca', name: 'A' };
      const categoryB = { id: 'cb', name: 'B' };
      const { client } = clientReading(
        [{ id: 'ca' }, { id: 'cb' }],
        [
          { ...categoryA, posts: [{ id: 'p1' }] },
          { ...categoryB, posts: [{ id: 'p2' }] },
        ],
      );

      const rows = await readRowsNotInResult(
        inputOf(client, 'Category', path, [hiddenParent('p1'), hiddenParent('p2')]),
      );

      expect(rows).toEqual([[categoryA], [categoryB]]);
    });
  });

  describe('updated rows the result does not hold', () => {
    it('reads them by primary key or by unique WHERE and returns each for the parent row it was nested under', async () => {
      const byKey = targetBy('rowKey', { id: 'pa' });
      const byWhere = targetBy('uniqueWhere', { authorId_slug: { authorId: 'u2', slug: 'b' } });
      const postA = { id: 'pa', authorId: 'u1', slug: 'a' };
      const postB = { id: 'pb', authorId: 'u2', slug: 'b' };
      const findMany = vi.fn(async (_args: unknown) => [postB, postA]);
      const parentOf = (id: string, target: LocatedTarget): ParentAtPath => ({
        row: { id },
        rows: [],
        absentTargets: [target],
        insertsHidden: false,
        isInserted: () => false,
      });

      const rows = await readRowsNotInResult(
        inputOf({ findMany }, 'Post', undefined, [parentOf('u1', byKey), parentOf('u2', byWhere)]),
      );

      expect(findMany.mock.calls).toEqual([[{ where: { OR: [{ id: 'pa' }, { authorId: 'u2', slug: 'b' }] } }]]);
      expect(rows).toEqual([[postA], [postB]]);
    });
  });

  describe('the inserted rows', () => {
    it('are the keys under the parent rows that the result does not hold and a parent row judges inserted', async () => {
      const path: ToManyPath = {
        parentModelName: 'User',
        parentKeyConstraint: pk,
        keyConstraint: pk,
        scope: {
          backField: 'author',
          filter: 'is',
          parentFields: ['id'],
          foreignKey: { fields: ['authorId'], references: ['id'] },
        },
      };
      const inserted = { id: 'new', authorId: 'u1' };
      const { client, findMany } = clientReading([{ id: 'held' }, { id: 'old' }, { id: 'new' }], [inserted]);
      const parent: ParentAtPath = {
        ...hiddenParent('u1'),
        rows: [{ id: 'held', authorId: 'u1' }],
        isInserted: (key) => key.id !== 'old',
      };

      const rows = await readRowsNotInResult(inputOf(client, 'Post', path, [parent]));

      expect(findMany).toHaveBeenLastCalledWith({ where: { OR: [{ id: 'new' }] } });
      expect(rows).toEqual([[inserted]]);
    });
  });

  describe('when nothing is missing from the result', () => {
    const fkPath: ToManyPath = {
      parentModelName: 'User',
      parentKeyConstraint: pk,
      keyConstraint: pk,
      scope: {
        backField: 'author',
        filter: 'is',
        parentFields: ['id'],
        foreignKey: { fields: ['authorId'], references: ['id'] },
      },
    };

    it('reads nothing for parents that neither hide inserted rows nor have absent targets', async () => {
      const { client, findMany } = clientReading([], []);
      const parent: ParentAtPath = {
        row: { id: 'u1' },
        rows: [],
        absentTargets: [],
        insertsHidden: false,
        isInserted: () => true,
      };

      const rows = await readRowsNotInResult(inputOf(client, 'Post', fkPath, [parent, parent]));

      expect(rows).toEqual([[], []]);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('reads the keys under the parent rows only, and no second time, when no key is missing from the result', async () => {
      const { client, findMany } = clientReading([{ id: 'held' }], []);
      const parent: ParentAtPath = { ...hiddenParent('u1'), rows: [{ id: 'held', authorId: 'u1' }] };

      const rows = await readRowsNotInResult(inputOf(client, 'Post', fkPath, [parent]));

      expect(rows).toEqual([[]]);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith({
        where: { OR: [{ author: { is: { id: 'u1' } } }] },
        select: { id: true },
      });
    });

    it('reads nothing for a parent row that lacks the key its rows hang under', async () => {
      const { client, findMany } = clientReading([{ id: 'new' }], [{ id: 'new', authorId: 'u1' }]);
      const keyless: ParentAtPath = { ...hiddenParent('u1'), row: { name: 'no id' } };

      const rows = await readRowsNotInResult(inputOf(client, 'Post', fkPath, [keyless]));

      expect(rows).toEqual([[]]);
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe('the include of the read', () => {
    const include = { comments: { include: { author: true } } };
    const absent = targetBy('rowKey', { id: 'pa' });
    const absentParent: ParentAtPath = {
      row: { id: 'u1' },
      rows: [],
      absentTargets: [absent],
      insertsHidden: false,
      isInserted: () => false,
    };

    it('passes the relations the operation writes below the path to the read of absent targets', async () => {
      const postA = { id: 'pa', authorId: 'u1' };
      const findMany = vi.fn(async (_args: unknown) => [postA]);

      const rows = await readRowsNotInResult({ ...inputOf({ findMany }, 'Post', undefined, [absentParent]), include });

      expect(findMany.mock.calls).toEqual([[{ where: { OR: [{ id: 'pa' }] }, include }]]);
      expect(rows).toEqual([[postA]]);
    });

    it('keeps them beside the link keys it reads for the inserted rows of an implicit many-to-many relation', async () => {
      const path: ToManyPath = {
        parentModelName: 'Post',
        parentKeyConstraint: pk,
        keyConstraint: pk,
        scope: { backField: 'posts', filter: 'some', parentFields: ['id'] },
      };
      const { client, findMany } = clientReading([{ id: 'ca' }], [{ id: 'ca', posts: [{ id: 'p1' }] }]);

      await readRowsNotInResult({ ...inputOf(client, 'Category', path, [hiddenParent('p1')]), include });

      expect(findMany).toHaveBeenLastCalledWith({
        where: { OR: [{ id: 'ca' }] },
        include: { ...include, posts: { where: { OR: [{ id: 'p1' }] }, select: { id: true } } },
      });
    });
  });
});
