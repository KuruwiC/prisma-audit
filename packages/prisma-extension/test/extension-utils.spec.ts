/**
 * Unit tests for `extractDeleteOperationEntityId` (extension-utils.ts)
 *
 * Focus: composite-key entityId extraction on the fallback (no-pre-fetch) path.
 * `extractDeleteOperationEntityId` reuses `unwrapCompoundWhere` (utils/compound-where.ts)
 * to read Prisma's compound-unique WHERE shape (`{ postId_userId: { postId, userId } }`),
 * so a composite-key nested delete still resolves an identity from the primary-key
 * fields named in the WHERE clause even when `nestedOperations.delete.fetchBeforeOperation`
 * is `false` and no pre-fetched before-state is available.
 */

import { describe, expect, it } from 'vitest';
import { extractDeleteOperationEntityId } from '../src/utils/extension-utils.js';

describe('extractDeleteOperationEntityId', () => {
  describe('single-field primary key (unaffected by the compound-unique unwrap)', () => {
    it('extracts a direct id field', () => {
      expect(extractDeleteOperationEntityId({ id: '123' })).toBe('123');
    });

    it('extracts an id field nested under where', () => {
      expect(extractDeleteOperationEntityId({ where: { id: '456' } })).toBe('456');
    });

    it('returns undefined when no recognizable PK field is present', () => {
      expect(extractDeleteOperationEntityId({ where: { email: 'user@example.com' } })).toBeUndefined();
    });
  });

  describe('composite primary key — Prisma compound-unique WHERE shape', () => {
    const pkFields = ['postId', 'userId'];

    it('unwraps the compound-unique wrapper passed directly (nested delete data shape) and extracts the composite entityId', () => {
      // This is exactly the shape `detectNestedDeletes` (core) hands `collectDeleteRecords`
      // for `post.update({ data: { postLikes: { delete: { postId_userId: { postId, userId } } } } })`
      // when pre-fetch is skipped (`fetchBeforeOperation: false`).
      const data = { postId_userId: { postId: 'post-1', userId: 'user-1' } };

      expect(extractDeleteOperationEntityId(data, pkFields)).toBe(JSON.stringify(['post-1', 'user-1']));
    });

    it('unwraps the compound-unique wrapper nested under where', () => {
      const data = { where: { postId_userId: { postId: 'post-2', userId: 'user-2' } } };

      expect(extractDeleteOperationEntityId(data, pkFields)).toBe(JSON.stringify(['post-2', 'user-2']));
    });

    it('still returns undefined when the WHERE names neither the compound key nor the individual PK fields', () => {
      const data = { note: 'not a valid unique where for this model' };

      expect(extractDeleteOperationEntityId(data, pkFields)).toBeUndefined();
    });

    it('an explicitly-named compound key (not pkFields.join("_")) stays unsupported on this fallback path', () => {
      // `unwrapCompoundWhere` can only reconstruct Prisma's *default* compound-key name
      // (`pkFields.join('_')`) from `pkFields` alone — a `@@id([...], name: "custom")`
      // key is not resolvable here (see its own doc comment). The WHERE clause under a
      // custom name is left unwrapped, so no PK fields are found directly on it.
      const data = { customCompoundKeyName: { postId: 'post-3', userId: 'user-3' } };

      expect(extractDeleteOperationEntityId(data, pkFields)).toBeUndefined();
    });
  });
});
