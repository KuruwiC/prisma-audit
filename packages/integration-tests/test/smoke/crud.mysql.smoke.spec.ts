import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/mysql-client/client';
import { setupMySQLDatabase, teardownMySQLDatabase } from '../helpers/setup-mysql.js';
import { describeCrudSmoke, smokeActor } from './crud-smoke-suite.js';

describeCrudSmoke({ name: 'MySQL', setup: setupMySQLDatabase, teardown: teardownMySQLDatabase }, (context) => {
  describe('nested delete', () => {
    it('records a nested deleted row under the parent as stored when the where names it in another case', async () => {
      await context.prisma.user.create({ data: { id: 'case-user', email: 'case@example.com', name: 'Case' } });
      await context.prisma.post.create({ data: { id: 'p1', title: 'Post', authorId: 'case-user' } });
      await context.prisma.auditLog.deleteMany();

      // MySQL's default collation compares strings case-insensitively, so 'CASE-USER' finds the row stored
      // as 'case-user'
      await context.provider.runAsync(smokeActor, () =>
        context.prisma.user.update({ where: { id: 'CASE-USER' }, data: { posts: { delete: { id: 'p1' } } } }),
      );

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: 'p1' },
        orderBy: [{ aggregateType: 'asc' }, { aggregateId: 'asc' }],
      });
      expect(
        auditLogs.map((log: Prisma.AuditLogGetPayload<object>) => [log.action, log.aggregateType, log.aggregateId]),
      ).toEqual([
        ['delete', 'Post', 'p1'],
        ['delete', 'User', 'case-user'],
      ]);
    });
  });

  describe('createMany with skipDuplicates', () => {
    it('records no create for a row it skipped because a row held its primary key, given in another case, before the write', async () => {
      await context.prisma.user.create({ data: { id: 'case-user', email: 'case@example.com', name: 'Case' } });
      await context.prisma.auditLog.deleteMany();

      // MySQL's default collation compares strings case-insensitively, so 'CASE-USER' is the key of the
      // row stored as 'case-user', and the row of data that gives it is skipped
      const result = await context.provider.runAsync(smokeActor, () =>
        context.prisma.user.createMany({
          data: [
            { id: 'CASE-USER', email: 'skipped@example.com', name: 'Skipped' },
            { id: 'fresh-user', email: 'fresh@example.com', name: 'Fresh' },
          ],
          skipDuplicates: true,
        }),
      );

      expect(result).toEqual({ count: 1 });
      const auditLogs = await context.prisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } });
      expect(auditLogs.map((log: Prisma.AuditLogGetPayload<object>) => [log.entityId, log.aggregateId])).toEqual([
        ['fresh-user', 'fresh-user'],
      ]);
    });
  });
});
