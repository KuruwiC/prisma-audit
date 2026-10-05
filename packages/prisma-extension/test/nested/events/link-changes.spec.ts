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
  precedingWrites: [],
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

  describe('the rows a write detaches', () => {
    const linkWrite = (
      operation: NestedOperationInfo['operation'],
      isList: boolean,
      named: Row[],
      detaches: boolean,
    ): LinkWrite => ({
      operation: { ...connect, operation, isList, data: named.length === 1 ? named[0] : named },
      named,
      detaches,
    });
    const readFor = (linkWriteValue: LinkWrite, rows: Row[], failed = false) =>
      readOf({
        writes: [linkWriteValue],
        rows,
        parentKeys: failed ? new Map() : new Map([[linkWriteValue.operation, { id: 'p1' }]]),
        failed,
      });
    const update = (entity: Row, before: Row) => ({
      entity,
      action: 'update',
      beforeState: { kind: 'captured', row: before },
      relatedModel: 'Label',
    });

    it('records the row a named to-many disconnect detached, and nothing for a named row attached elsewhere', async () => {
      const disconnect = linkWrite('disconnect', true, [{ id: 'l1' }, { id: 'l2' }], false);
      const l1 = { id: 'l1', name: 'one', postId: 'p1' };
      const l2 = { id: 'l2', name: 'two', postId: 'p2' };

      const { records } = await collect(readFor(disconnect, [l1, l2]), [{ ...l1, postId: null }, l2]);

      expect(records.get(disconnect.operation)).toEqual([update({ ...l1, postId: null }, l1)]);
    });

    it('records the rows a set attaches by name and the rows it detaches without naming them, reading neither a kept row', async () => {
      const set = linkWrite('set', true, [{ id: 'l1' }, { id: 'l3' }], true);
      const l1 = { id: 'l1', name: 'attached', postId: 'p2' };
      const l2 = { id: 'l2', name: 'detached', postId: 'p1' };
      const l3 = { id: 'l3', name: 'kept', postId: 'p1' };

      const { records, findMany } = await collect(readFor(set, [l1, l2, l3]), [
        { ...l1, postId: 'p1' },
        { ...l2, postId: null },
      ]);

      expect(findMany).toHaveBeenCalledWith({ where: { OR: [{ id: 'l1' }, { id: 'l2' }] } });
      expect(records.get(set.operation)).toEqual([
        update({ ...l1, postId: 'p1' }, l1),
        update({ ...l2, postId: null }, l2),
      ]);
    });

    it('records the row a to-one connect replaces along with the row it connects', async () => {
      const replace = linkWrite('connect', false, [{ id: 'l9' }], true);
      const replaced = { id: 'l1', name: 'old', postId: 'p1' };
      const connected = { id: 'l9', name: 'new', postId: null };

      const { records } = await collect(readFor(replace, [replaced, connected]), [
        { ...replaced, postId: null },
        { ...connected, postId: 'p1' },
      ]);

      expect(records.get(replace.operation)).toEqual([
        update({ ...connected, postId: 'p1' }, connected),
        update({ ...replaced, postId: null }, replaced),
      ]);
    });

    it('when the read before the write failed, records a named disconnected row only when it holds no parent after the write', async () => {
      const disconnect = linkWrite('disconnect', true, [{ id: 'l1' }, { id: 'l2' }], false);
      const detached = { id: 'l1', name: 'one', postId: null };
      const attachedElsewhere = { id: 'l2', name: 'two', postId: 'p2' };

      const { records } = await collect(readFor(disconnect, [], true), [detached, attachedElsewhere]);

      expect(records.get(disconnect.operation)).toEqual([
        { entity: detached, action: 'update', beforeState: { kind: 'unavailable' }, relatedModel: 'Label' },
      ]);
    });
  });
});
