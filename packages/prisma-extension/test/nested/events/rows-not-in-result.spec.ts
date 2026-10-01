/**
 * Tests for the rows an operation wrote at a to-many path that the result does not hold: rows
 * inserted under parent rows whose relation the caller restricted are returned for the parent row
 * they hang under only.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ParentAtPath,
  type RowsNotInResultInput,
  readRowsNotInResult,
} from '../../../src/nested/events/rows-not-in-result.js';
import type { PreFetchListClient } from '../../../src/nested/pre-fetch/model-client.js';
import type { ToManyPath } from '../../../src/nested/pre-fetch/to-many-path.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { createSchemaMetadataFromDMMF } from '../../../src/utils/schema-metadata.js';

type Row = Record<string, unknown>;

const scalar = (name: string) => ({ name, kind: 'scalar', type: 'String', isList: false });

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        { name: 'Post', fields: [{ ...scalar('id'), isId: true }, scalar('authorId')] },
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

/** A client that returns the primary keys of the rows under the parents, then those rows whole */
const clientReading = (keys: Row[], rows: Row[]) => {
  const findMany = vi.fn(async (args: { select?: Record<string, unknown> }) => (args.select ? keys : rows));
  return { client: { findMany } satisfies PreFetchListClient, findMany };
};

const inputOf = (
  client: PreFetchListClient,
  relatedModel: string,
  path: ToManyPath,
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
});
