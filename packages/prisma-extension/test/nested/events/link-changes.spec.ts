/**
 * Tests for the foreign-key changes of the rows a link write re-linked: which candidates are
 * read again after the write and which of them are recorded
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedOperationInfo, NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { collectLinkChanges, type LinkChangesInput } from '../../../src/nested/events/link-changes.js';
import type { LinkPathRead, LinkWrite, RelatedSideLink } from '../../../src/nested/pre-fetch/link-rows.js';
import { storeReadResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { NO_AUDITED_OMITTED_FIELDS } from '../../../src/utils/audited-omitted-fields.js';
import { extractEntityIdentity } from '../../../src/utils/id-generation.js';

type Row = Record<string, unknown>;

const link: RelatedSideLink = {
  side: 'related',
  parentModel: 'Post',
  fields: ['postId'],
  references: ['id'],
  optional: true,
};

const connect: NestedOperationInfo = {
  fieldName: 'labels',
  writesBefore: [],
  relatedModel: 'Label',
  operation: 'connect',
  isList: true,
  data: { id: 'l1' },
  path: 'labels',
};
const write: LinkWrite = { operation: connect, named: [{ id: 'l1' }], detaches: false };

/** The read before a connect of `l1` to the post `p1`, which finds `l1` attached to `p2` */
const readOf = (overrides: Partial<LinkPathRead> = {}): LinkPathRead => ({
  relatedModel: 'Label',
  pkFields: ['id'],
  link,
  writes: [write],
  rows: [{ id: 'l1', name: 'before', postId: 'p2' }],
  parentKeys: new Map([[connect, { id: 'p1' }]]),
  failed: false,
  ...overrides,
});

/** The records of a link write at `labels`, with `after` the rows the read after the write returns */
const collect = async (
  read: LinkPathRead,
  after: Row[],
  audited: readonly string[] = [],
  nestedPreFetchResults: NestedPreFetchResults = new Map(),
) => {
  const findMany = vi.fn(async () => after);
  const input: LinkChangesInput = {
    client: { label: { findMany } },
    linkReads: new Map([['labels', read]]),
    nestedPreFetchResults,
    auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
    auditedAt: () => new Set(audited.map((id) => extractEntityIdentity({ id }, ['id']))),
    fieldNamesOf: () => new Set(['id', 'name', 'postId']),
  };
  return { records: await collectLinkChanges(input), findMany };
};

describe('collectLinkChanges', () => {
  it('records a row whose foreign key changed, with the row read before the write as its before state', async () => {
    const after = { id: 'l1', name: 'before', postId: 'p1' };
    const { records } = await collect(readOf(), [after]);

    expect(records.get(connect)).toEqual([
      {
        entity: after,
        action: 'update',
        beforeState: { kind: 'captured', row: { id: 'l1', name: 'before', postId: 'p2' } },
        relatedModel: 'Label',
      },
    ]);
  });

  it('records nothing for a row whose foreign key did not change, whatever else differs', async () => {
    const { records } = await collect(readOf(), [{ id: 'l1', name: 'after', postId: 'p2' }]);

    expect(records.size).toBe(0);
  });

  it('does not read again a row another nested write audits', async () => {
    const { records, findMany } = await collect(readOf(), [{ id: 'l1', name: 'before', postId: 'p1' }], ['l1']);

    expect(records.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('records nothing for a row another nested write audits when the read before the write failed', async () => {
    const failed = readOf({ rows: [], parentKeys: new Map(), failed: true });
    const { records, findMany } = await collect(failed, [{ id: 'l1', name: 'before', postId: 'p1' }], ['l1']);

    expect(records.size).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('records a row two writes name once, with the before state of the write that read it', async () => {
    const connectOrCreate: NestedOperationInfo = {
      ...connect,
      operation: 'connectOrCreate',
      data: { where: { id: 'l1' }, create: { id: 'l1', name: 'new' } },
    };
    const connectedOrCreated: LinkWrite = { operation: connectOrCreate, named: [], detaches: false };
    const readBefore = { id: 'l1', name: 'before', postId: 'p2' };
    const nestedPreFetchResults: NestedPreFetchResults = new Map();
    storeReadResult(nestedPreFetchResults, 'labels', { id: 'l1' }, readBefore, { type: 'primaryKey', fields: ['id'] });
    const failed = readOf({
      writes: [write, connectedOrCreated],
      rows: [],
      parentKeys: new Map([
        [connect, { id: 'p1' }],
        [connectOrCreate, { id: 'p1' }],
      ]),
      failed: true,
    });
    const after = { id: 'l1', name: 'before', postId: 'p1' };

    const { records } = await collect(failed, [after], [], nestedPreFetchResults);

    expect(records.get(connect)).toBeUndefined();
    expect(records.get(connectOrCreate)).toEqual([
      { entity: after, action: 'update', beforeState: { kind: 'captured', row: readBefore }, relatedModel: 'Label' },
    ]);
  });
});
