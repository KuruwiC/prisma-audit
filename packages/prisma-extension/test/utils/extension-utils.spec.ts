/**
 * Unit tests for `extractDeleteOperationEntityId` (extension-utils.ts)
 *
 * Focus: composite-key entityId extraction on the fallback (no-pre-fetch) path.
 * `extractDeleteOperationEntityId` reuses `unwrapCompoundWhere` (utils/compound-where.ts)
 * to read Prisma's compound-unique WHERE shape (`{ postId_userId: { postId, userId } }`,
 * or `{ <name>: { ... } }` for a key declared with an explicit name), so a composite-key
 * nested delete resolves an identity from the primary-key fields named in the WHERE
 * clause even when `fetchBefore.delete` is `false` and no
 * pre-fetched before-state is available.
 */

import { createEntityConfigLookup, defineEntity } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import type { UniqueConstraint } from '../../src/schema/types.js';
import { extractDeleteOperationEntityId, shouldAuditModel } from '../../src/utils/extension-utils.js';

describe('extractDeleteOperationEntityId', () => {
  describe('single-field primary key (unaffected by the compound-unique unwrap)', () => {
    const idPrimaryKey: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };

    it('extracts a direct id field', () => {
      expect(extractDeleteOperationEntityId({ id: '123' }, idPrimaryKey)).toBe('123');
    });

    it('extracts an id field nested under where', () => {
      expect(extractDeleteOperationEntityId({ where: { id: '456' } }, idPrimaryKey)).toBe('456');
    });

    it('returns undefined when no recognizable PK field is present', () => {
      expect(extractDeleteOperationEntityId({ where: { email: 'user@example.com' } }, idPrimaryKey)).toBeUndefined();
    });
  });

  describe('composite primary key — Prisma compound-unique WHERE shape', () => {
    const pkConstraint: UniqueConstraint = { type: 'primaryKey', fields: ['postId', 'userId'] };

    it('unwraps the compound-unique wrapper passed directly (nested delete data shape) and extracts the composite entityId', () => {
      // The data of `post.update({ data: { postLikes: { delete: { postId_userId: { postId, userId } } } } })`.
      const data = { postId_userId: { postId: 'post-1', userId: 'user-1' } };

      expect(extractDeleteOperationEntityId(data, pkConstraint)).toBe(JSON.stringify(['post-1', 'user-1']));
    });

    it('unwraps the compound-unique wrapper nested under where', () => {
      const data = { where: { postId_userId: { postId: 'post-2', userId: 'user-2' } } };

      expect(extractDeleteOperationEntityId(data, pkConstraint)).toBe(JSON.stringify(['post-2', 'user-2']));
    });

    it('still returns undefined when the WHERE names neither the compound key nor the individual PK fields', () => {
      const data = { note: 'not a valid unique where for this model' };

      expect(extractDeleteOperationEntityId(data, pkConstraint)).toBeUndefined();
    });
  });

  describe('composite primary key with an explicit name (`@@id([...], name: "bookmarkKey")`)', () => {
    const namedPkConstraint: UniqueConstraint = {
      type: 'primaryKey',
      fields: ['postId', 'userId'],
      name: 'bookmarkKey',
    };

    it('unwraps the wrapper keyed by the declared name and extracts the composite entityId', () => {
      const data = { bookmarkKey: { postId: 'post-3', userId: 'user-3' } };

      expect(extractDeleteOperationEntityId(data, namedPkConstraint)).toBe(JSON.stringify(['post-3', 'user-3']));
    });

    it('unwraps the wrapper keyed by the declared name nested under where', () => {
      const data = { where: { bookmarkKey: { postId: 'post-4', userId: 'user-4' } } };

      expect(extractDeleteOperationEntityId(data, namedPkConstraint)).toBe(JSON.stringify(['post-4', 'user-4']));
    });
  });
});

describe('shouldAuditModel', () => {
  const { isLoggable } = createEntityConfigLookup({
    User: defineEntity({ type: 'User' }),
    AuditLog: defineEntity({ type: 'AuditLog' }),
  });

  it('audits a model the aggregate mapping declares', () => {
    expect(shouldAuditModel({ modelName: 'User', auditLogModel: 'AuditLog', isLoggable })).toBe(true);
  });

  it('skips a model the aggregate mapping does not declare', () => {
    expect(shouldAuditModel({ modelName: 'Session', auditLogModel: 'AuditLog', isLoggable })).toBe(false);
  });

  it('skips the audit-log model whatever the case it is configured in, even when the mapping declares it', () => {
    expect(shouldAuditModel({ modelName: 'AuditLog', auditLogModel: 'AuditLog', isLoggable })).toBe(false);
    expect(shouldAuditModel({ modelName: 'AuditLog', auditLogModel: 'auditLog', isLoggable })).toBe(false);
    expect(shouldAuditModel({ modelName: 'AuditLog', auditLogModel: 'AUDITLOG', isLoggable })).toBe(false);
  });
});
