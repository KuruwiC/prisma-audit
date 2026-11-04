/**
 * Integration Test: an updateMany whose data writes no field
 *
 * Prisma runs no `UPDATE` for an updateMany whose data gives no field a value, not even to set an
 * `@updatedAt` column, and the count it returns does not count rows written (0 on SQLite, the rows
 * the `where` matches on PostgreSQL). The audit reads no row for it, records nothing and reports
 * nothing.
 */

import type { AuditContext, AuditObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
import { cleanDatabase, createBasePrisma, testAuditOptions } from './helpers/setup.js';

const actor: AuditContext = { actor: { category: 'model', type: 'User', id: 'writes-no-field-actor' } };

describe('an updateMany whose data writes no field', () => {
  const observer = vi.fn<AuditObserver>();
  const provider = createAsyncLocalStorageProvider();
  const base = createBasePrisma();
  const prisma = createAuditClient(base, {
    ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
    observer,
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await base.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(base);
    observer.mockClear();
  });

  it.each([
    ['empty data', {}],
    ['data whose every field is undefined', { title: undefined }],
  ])(
    'changes no row, records nothing and reports nothing for %s, while its where matches a row',
    async (_case, data) => {
      const user = await base.user.create({ data: { email: 'owner@example.com', name: 'Owner', password: 'x' } });
      const post = await base.post.create({ data: { title: 'Kept', content: 'kept', authorId: user.id } });

      await provider.runAsync(actor, () => prisma.post.updateMany({ where: { id: post.id }, data }));

      expect(await base.post.findUniqueOrThrow({ where: { id: post.id } })).toEqual(post);
      expect(await base.auditLog.count()).toBe(0);
      expect(failuresOf(observer)).toEqual([]);
    },
  );
});
