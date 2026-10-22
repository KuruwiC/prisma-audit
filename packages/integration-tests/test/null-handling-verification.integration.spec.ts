/**
 * Integration Test: NULL Handling Verification
 *
 * Verifies that database NULL (not JSON null) is stored for before/after fields
 * when they should be absent. Uses raw SQL queries to check actual database values,
 * since Prisma returns both SQL NULL and JSON null as JavaScript null.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it } from 'vitest';
import { setupTestContext, testEntities } from './helpers/setup.js';

describe('NULL Handling Verification', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('CREATE operation', () => {
    it('should store SQL NULL (not JSON null) for before field', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
          },
        });
      });

      const auditLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog?.before).toBeNull();

      type RawQueryResult = {
        id: string;
        before: unknown;
        before_is_null: boolean;
        before_type: string | null;
      };
      const rawResult = (await context.prisma.$queryRaw(
        Prisma.sql`
          SELECT
            id,
            before,
            (before IS NULL) AS before_is_null,
            pg_typeof(before)::text AS before_type
          FROM audit_logs
          WHERE id = ${auditLog?.id}
        `,
      )) as RawQueryResult[];

      expect(rawResult).toHaveLength(1);
      const raw = rawResult[0];
      expect(raw).toBeDefined();

      if (!raw) {
        throw new Error('Expected rawResult[0] to be defined');
      }

      expect(raw.before_is_null).toBe(true);
      expect(raw.before).toBeNull();
    });
  });

  describe('DELETE operation', () => {
    it('should store SQL NULL (not JSON null) for after field', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
          },
        });
      });

      await context.prisma.auditLog.deleteMany({});

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: user.id },
        });
      });

      const auditLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'delete' },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog?.after).toBeNull();

      type RawQueryResult = {
        id: string;
        after: unknown;
        after_is_null: boolean;
        after_type: string | null;
      };
      const rawResult = (await context.prisma.$queryRaw(
        Prisma.sql`
          SELECT
            id,
            after,
            (after IS NULL) AS after_is_null,
            pg_typeof(after)::text AS after_type
          FROM audit_logs
          WHERE id = ${auditLog?.id}
        `,
      )) as RawQueryResult[];

      expect(rawResult).toHaveLength(1);
      const raw = rawResult[0];
      expect(raw).toBeDefined();

      if (!raw) {
        throw new Error('Expected rawResult[0] to be defined');
      }

      expect(raw.after_is_null).toBe(true);
      expect(raw.after).toBeNull();
    });
  });

  describe('UPDATE operation', () => {
    it('should store JSONB objects (not NULL) for both before and after', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
          },
        });
      });

      await context.prisma.auditLog.deleteMany({});

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Jane Doe' },
        });
      });

      const auditLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog?.before).not.toBeNull();
      expect(auditLog?.after).not.toBeNull();

      type RawQueryResult = {
        id: string;
        before_is_null: boolean;
        after_is_null: boolean;
        before_type: string | null;
        after_type: string | null;
      };
      const rawResult = (await context.prisma.$queryRaw(
        Prisma.sql`
          SELECT
            id,
            (before IS NULL) AS before_is_null,
            (after IS NULL) AS after_is_null,
            pg_typeof(before)::text AS before_type,
            pg_typeof(after)::text AS after_type
          FROM audit_logs
          WHERE id = ${auditLog?.id}
        `,
      )) as RawQueryResult[];

      expect(rawResult).toHaveLength(1);
      const raw = rawResult[0];
      expect(raw).toBeDefined();

      if (!raw) {
        throw new Error('Expected rawResult[0] to be defined');
      }

      expect(raw.before_is_null).toBe(false);
      expect(raw.after_is_null).toBe(false);
      expect(raw.before_type).toBe('jsonb');
      expect(raw.after_type).toBe('jsonb');
    });

    it('should store SQL NULL (not JSON null) for before field when the before state is not read', async () => {
      const unreadBefore = createAuditClient(context.basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: context.provider,
        entities: testEntities,
        performance: { awaitWrite: true },
        fetchBefore: { update: false },
      });
      const user = await context.basePrisma.user.create({ data: { email: 'test@example.com', name: 'John Doe' } });

      await context.provider.runAsync(testActor, async () => {
        await unreadBefore.user.update({ where: { id: user.id }, data: { name: 'Jane Doe' } });
      });

      const auditLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });
      expect(auditLog).not.toBeNull();

      type RawQueryResult = {
        before_is_null: boolean;
        after_is_null: boolean;
        after_type: string | null;
      };
      const rawResult = (await context.prisma.$queryRaw(
        Prisma.sql`
          SELECT
            (before IS NULL) AS before_is_null,
            (after IS NULL) AS after_is_null,
            pg_typeof(after)::text AS after_type
          FROM audit_logs
          WHERE id = ${auditLog?.id}
        `,
      )) as RawQueryResult[];

      expect(rawResult).toEqual([{ before_is_null: true, after_is_null: false, after_type: 'jsonb' }]);
    });
  });
});
