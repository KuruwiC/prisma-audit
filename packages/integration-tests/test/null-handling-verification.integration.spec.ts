/**
 * Integration Test: NULL Handling Verification
 *
 * Verifies that database NULL (not JSON null) is stored for before/after fields
 * when they should be absent. Uses raw SQL queries to check actual database values,
 * since Prisma returns both SQL NULL and JSON null as JavaScript null.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { Prisma } from '@kuruwic/prisma-audit-database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('NULL Handling Verification', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

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

      expect(auditLog).toBeDefined();
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

      console.log('Raw database values for CREATE operation:');
      console.log('  before:', raw.before);
      console.log('  before IS NULL:', raw.before_is_null);
      console.log('  pg_typeof(before):', raw.before_type);

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

      // Find the audit log
      const auditLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'delete' },
      });

      expect(auditLog).toBeDefined();
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

      console.log('Raw database values for DELETE operation:');
      console.log('  after:', raw.after);
      console.log('  after IS NULL:', raw.after_is_null);
      console.log('  pg_typeof(after):', raw.after_type);

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

      // Find the audit log
      const auditLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(auditLog).toBeDefined();
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

      console.log('Raw database values for UPDATE operation:');
      console.log('  before IS NULL:', raw.before_is_null);
      console.log('  after IS NULL:', raw.after_is_null);
      console.log('  pg_typeof(before):', raw.before_type);
      console.log('  pg_typeof(after):', raw.after_type);

      expect(raw.before_is_null).toBe(false);
      expect(raw.after_is_null).toBe(false);
      expect(raw.before_type).toBe('jsonb');
      expect(raw.after_type).toBe('jsonb');
    });
  });
});
