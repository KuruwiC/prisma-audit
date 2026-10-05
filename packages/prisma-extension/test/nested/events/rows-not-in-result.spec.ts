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
import type { NestedWriteTarget } from '../../../src/nested/events/write-set.js';
import type { PreFetchListClient } from '../../../src/nested/pre-fetch/model-client.js';
import type { ToManyPath } from '../../../src/nested/pre-fetch/to-many-path.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { extractEntityIdentity } from '../../../src/utils/id-generation.js';
import { createSchemaMetadataFromDMMF } from '../../../src/utils/schema-metadata.js';

type Row = Record<string, unknown>;

const scalar = (name: string) => ({ name, kind: 'scalar', type: 'String', isList: false });

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        { name: 'Post', fields: [{ ...scalar('id'), isId: true }, scalar('authorId'), scalar('slug')] },
        { name: 'Category', fields: [{ ...scalar('id'), isId: true }, scalar('name')] },
      ],
    },
  },
});

const pk: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };

const hiddenParent = (id: string): ParentAtPath => ({
  row: { id },
  rows: [],
  absentTargets: [],
  insertsHidden: true,
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

const targetBy = (by: 'primaryKey' | 'uniqueWhere', where: Row): NestedWriteTarget => ({
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
  pkFields: ['id'],
  targets: [],
  preExisting: new Set(),
  parents,
  resolvePath: () => path,
  include: undefined,
});

describe('readRowsNotInResult', () => {
  describe('rows inserted under parent rows whose relation the caller restricted', () => {
    it('returns each inserted row for the parent row whose key its foreign key holds', async () => {
      const path: ToManyPath = {
        parentModelName: 'User',
        parentPk: pk,
        pk,
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
        parentPk: pk,
        pk,
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
      const byKey = targetBy('primaryKey', { id: 'pa' });
      const byWhere = targetBy('uniqueWhere', { authorId_slug: { authorId: 'u2', slug: 'b' } });
      const postA = { id: 'pa', authorId: 'u1', slug: 'a' };
      const postB = { id: 'pb', authorId: 'u2', slug: 'b' };
      const findMany = vi.fn(async (_args: unknown) => [postB, postA]);
      const parentOf = (id: string, target: NestedWriteTarget): ParentAtPath => ({
        row: { id },
        rows: [],
        absentTargets: [target],
        insertsHidden: false,
      });

      const rows = await readRowsNotInResult({
        ...inputOf({ findMany }, 'Post', undefined, [parentOf('u1', byKey), parentOf('u2', byWhere)]),
        targets: [byKey, byWhere],
      });

      expect(findMany.mock.calls).toEqual([[{ where: { OR: [{ id: 'pa' }, { authorId: 'u2', slug: 'b' }] } }]]);
      expect(rows).toEqual([[postA], [postB]]);
    });
  });

  describe('the inserted rows', () => {
    it('are the keys under the parent row that neither the result, the pre-write snapshot nor a target holds', async () => {
      const path: ToManyPath = {
        parentModelName: 'User',
        parentPk: pk,
        pk,
        scope: {
          backField: 'author',
          filter: 'is',
          parentFields: ['id'],
          foreignKey: { fields: ['authorId'], references: ['id'] },
        },
      };
      const inserted = { id: 'new', authorId: 'u1' };
      const { client, findMany } = clientReading(
        [{ id: 'held' }, { id: 'old' }, { id: 'named' }, { id: 'new' }],
        [inserted],
      );
      const named = targetBy('primaryKey', { id: 'named' });

      const rows = await readRowsNotInResult({
        ...inputOf(client, 'Post', path, [{ ...hiddenParent('u1'), rows: [{ id: 'held', authorId: 'u1' }] }]),
        targets: [named],
        preExisting: new Set([extractEntityIdentity({ id: 'old' }, ['id'])]),
      });

      expect(findMany).toHaveBeenLastCalledWith({ where: { OR: [{ id: 'new' }] } });
      expect(rows).toEqual([[inserted]]);
    });
  });
});
