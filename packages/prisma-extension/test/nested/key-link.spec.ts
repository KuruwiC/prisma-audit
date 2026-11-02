/**
 * Tests for the row-key fields that hold the foreign key to the parent row: which relations have
 * them, and how a key or a unique WHERE names its row with those fields taken from the parent row
 */

import { describe, expect, it } from 'vitest';
import { keyLinkOf, keyLinkValuesOf, relinked, withoutKeyLink } from '../../src/nested/key-link.js';
import type { UniqueConstraint } from '../../src/schema/types.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

const schemaMetadata = schemaMetadataOf(
  model('Device', [
    column('code', { isUnique: true, isRequired: true }),
    relation('sensors', 'DeviceSensor', 'DeviceSensors', { isList: true }),
    relation('posts', 'Post', 'DevicePosts', { isList: true }),
  ]),
  model(
    'DeviceSensor',
    [
      column('deviceCode', { isRequired: true }),
      column('slot', { isRequired: true }),
      relation('device', 'Device', 'DeviceSensors', {
        isRequired: true,
        foreignKeyFields: ['deviceCode'],
        referencedFields: ['code'],
      }),
    ],
    { uniqueIndexes: [{ fields: ['deviceCode', 'slot'], name: null }] },
  ),
  model('Post', [
    column('id', { isId: true }),
    column('deviceCode'),
    relation('device', 'Device', 'DevicePosts', { foreignKeyFields: ['deviceCode'], referencedFields: ['code'] }),
  ]),
);

const sensorKey: UniqueConstraint = { type: 'uniqueIndex', fields: ['deviceCode', 'slot'] };
const sensors = { path: 'sensors', fieldName: 'sensors', relatedModel: 'DeviceSensor' };

describe('keyLinkOf', () => {
  it('is the foreign-key fields of the row key and the parent fields they reference', () => {
    expect(keyLinkOf(schemaMetadata, 'Device', sensors)).toEqual({
      parentModel: 'Device',
      fields: ['deviceCode'],
      references: ['code'],
    });
  });

  it('is undefined for a relation whose foreign key the row key does not hold', () => {
    expect(keyLinkOf(schemaMetadata, 'Device', { path: 'posts', fieldName: 'posts', relatedModel: 'Post' })).toBe(
      undefined,
    );
  });
});

describe('relinked', () => {
  const link = { parentModel: 'Device', fields: ['deviceCode'], references: ['code'] };
  const values = keyLinkValuesOf(link, { code: 'd-9', label: 'L' });

  it('gives a row key the values of the parent row after the write', () => {
    expect(relinked({ deviceCode: 'd-1', slot: 1 }, values, sensorKey)).toEqual({ deviceCode: 'd-9', slot: 1 });
  });

  it('lifts the compound-key wrapper of a unique WHERE before giving it the values', () => {
    expect(relinked({ deviceCode_slot: { deviceCode: 'd-1', slot: 1 } }, values, sensorKey)).toEqual({
      deviceCode: 'd-9',
      slot: 1,
    });
  });

  it('keeps a WHERE that names none of the fields, and any WHERE when the parent values are unknown', () => {
    expect(relinked({ id: 'p1' }, values, sensorKey)).toEqual({ id: 'p1' });
    expect(relinked({ deviceCode: 'd-1', slot: 1 }, keyLinkValuesOf(link, { label: 'L' }), sensorKey)).toEqual({
      deviceCode: 'd-1',
      slot: 1,
    });
  });

  it('leaves out the fields from a key compared under one parent row', () => {
    expect(withoutKeyLink({ deviceCode: 'd-1', slot: 1 }, link)).toEqual({ slot: 1 });
  });
});
