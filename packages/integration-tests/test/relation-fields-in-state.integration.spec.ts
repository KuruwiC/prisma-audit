/**
 * Relation fields loaded via `include` belong to the operation result, not the entity's own
 * columns, so they must not appear in the `before`/`after` audit log state. The extension
 * identifies them from the `Prisma` namespace passed to `createAuditClient`.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'relation-fields-actor' },
};

const stateKeys = (state: unknown): string[] => (state !== null && typeof state === 'object' ? Object.keys(state) : []);

describe('relation fields in audited entity state', () => {
  let sharedDatabaseUrl: string;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  const createClient = (databaseUrl: string) => {
    const basePrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
    });
    return { basePrisma, provider, prisma };
  };

  let scenario: ReturnType<typeof createClient>;

  beforeEach(async () => {
    scenario = createClient(sharedDatabaseUrl);
    await scenario.basePrisma.auditLog.deleteMany();
    await scenario.basePrisma.post.deleteMany();
    await scenario.basePrisma.user.deleteMany();
  });

  afterEach(async () => {
    await scenario.basePrisma.$disconnect();
  });

  it('keeps an included to-many relation out of a single update log', async () => {
    const { prisma, basePrisma, provider } = scenario;
    const user = await basePrisma.user.create({
      data: {
        email: 'relation-fields-update@example.com',
        name: 'Before Rename',
        posts: { create: { title: 'Existing Post' } },
      },
    });

    const updated = await provider.runAsync(testActor, async () =>
      prisma.user.update({ where: { id: user.id }, data: { name: 'After Rename' }, include: { posts: true } }),
    );
    expect(updated.posts).toHaveLength(1);

    const logs = await basePrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'update' },
    });
    expect(logs).toHaveLength(1);
    const [log] = logs;
    expect(stateKeys(log?.after)).toContain('name');
    expect(stateKeys(log?.after)).not.toContain('posts');
    expect(stateKeys(log?.before)).toContain('name');
    expect(stateKeys(log?.before)).not.toContain('posts');
    expect(log?.changes).toEqual({ name: { old: 'Before Rename', new: 'After Rename' } });
  });

  it('keeps an included relation count out of a single update log', async () => {
    const { prisma, basePrisma, provider } = scenario;
    const user = await basePrisma.user.create({
      data: {
        email: 'relation-count-update@example.com',
        name: 'Before Rename',
        posts: { create: { title: 'Existing Post' } },
      },
    });

    const updated = await provider.runAsync(testActor, async () =>
      prisma.user.update({ where: { id: user.id }, data: { name: 'After Rename' }, include: { _count: true } }),
    );
    expect(updated._count.posts).toBe(1);

    const [log] = await basePrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'update' },
    });
    expect(stateKeys(log?.after)).not.toContain('_count');
    expect(log?.changes).toEqual({ name: { old: 'Before Rename', new: 'After Rename' } });
  });

  it('keeps an included to-one relation out of batch create logs', async () => {
    const { prisma, basePrisma, provider } = scenario;
    const user = await basePrisma.user.create({ data: { email: 'relation-fields-batch@example.com', name: 'Author' } });

    const created = await provider.runAsync(testActor, async () =>
      prisma.post.createManyAndReturn({
        data: [
          { title: 'Batch Post A', authorId: user.id },
          { title: 'Batch Post B', authorId: user.id },
        ],
        include: { author: true },
      }),
    );
    expect(created.map((post) => post.author.id)).toEqual([user.id, user.id]);

    const createdIds = created.map((post) => post.id);
    const logs = await basePrisma.auditLog.findMany({
      where: { entityType: 'Post', entityId: { in: createdIds }, action: 'create' },
    });
    expect(new Set(logs.map((log) => log.entityId))).toEqual(new Set(createdIds));
    for (const log of logs) {
      expect(stateKeys(log.after)).toContain('title');
      expect(stateKeys(log.after)).not.toContain('author');
    }
  });
});
