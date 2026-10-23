/**
 * Integration Tests: a write that stores the values a row already holds
 *
 * Prisma sets an `@updatedAt` column on every update, so an `update` or the update branch of an
 * `upsert` that writes identical values still changes that column. An `upsert` and an `update`
 * record the same audit logs for it: with `updatedAt` an ordinary field the logs are `update`
 * logs whose only change is `updatedAt`, and with `updatedAt` in the entity's `diffExcludeFields`
 * neither writes a log. Each case runs the same data through both operations.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { EntityMap } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'unchanged-write-actor' },
};

const createMapping = (diffExcludeFields: string[] | undefined): EntityMap => ({
  User: defineEntity({ type: 'User' }),
  Profile: defineEntity({ type: 'Profile', diffExcludeFields, aggregates: [to('User', foreignKey('userId'))] }),
  Avatar: defineEntity({ type: 'Avatar', diffExcludeFields, aggregates: [to('Profile', foreignKey('profileId'))] }),
  AvatarImage: defineEntity({
    type: 'AvatarImage',
    diffExcludeFields,
    aggregates: [to('Avatar', foreignKey('avatarId'))],
  }),
});

describe('A write that stores the values a row already holds', () => {
  let basePrisma: PrismaClient;
  const provider = createAsyncLocalStorageProvider();

  const createClient = (diffExcludeFields: string[] | undefined) =>
    createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: createMapping(diffExcludeFields),
      diffExcludeFields: ['createdAt'],
      write: { awaited: true },
      fetchBefore: { update: true, delete: true },
    });
  type AuditedClient = ReturnType<typeof createClient>;

  const seedUser = async () =>
    basePrisma.user.create({
      data: {
        email: 'unchanged-write@example.com',
        name: 'Unchanged Write',
        password: 'secret123',
        profile: {
          create: {
            bio: 'Original bio',
            avatar: {
              create: { name: 'Original Avatar', avatarImage: { create: { imageUrl: 'https://example.com/a.png' } } },
            },
          },
        },
      },
    });

  /** `entityType:aggregateType:action:changed columns` of every audit log, sorted */
  const recordedWrites = async (): Promise<string[]> =>
    (await basePrisma.auditLog.findMany())
      .map((log) => `${log.entityType}:${log.aggregateType}:${log.action}:${Object.keys(log.changes ?? {}).join(',')}`)
      .sort();

  const unchangedWrites = {
    'a single row': {
      upsert: (client: AuditedClient, userId: string) =>
        client.profile.upsert({
          where: { userId },
          create: { userId, bio: 'Should not be used' },
          update: { bio: 'Original bio' },
        }),
      update: (client: AuditedClient, userId: string) =>
        client.profile.update({ where: { userId }, data: { bio: 'Original bio' } }),
    },
    'a row and the rows nested three levels deep': {
      upsert: (client: AuditedClient, userId: string) =>
        client.profile.upsert({
          where: { userId },
          create: { userId, bio: 'Should not be used' },
          update: {
            bio: 'Original bio',
            avatar: {
              upsert: {
                create: { name: 'Should not be used' },
                update: {
                  name: 'Original Avatar',
                  avatarImage: {
                    upsert: {
                      create: { imageUrl: 'https://example.com/should-not-be-used.png' },
                      update: { imageUrl: 'https://example.com/a.png' },
                    },
                  },
                },
              },
            },
          },
        }),
      update: (client: AuditedClient, userId: string) =>
        client.profile.update({
          where: { userId },
          data: {
            bio: 'Original bio',
            avatar: {
              update: {
                name: 'Original Avatar',
                avatarImage: { update: { imageUrl: 'https://example.com/a.png' } },
              },
            },
          },
        }),
    },
  };

  const recordedWritesByShape = {
    'a single row': ['Profile:Profile:update:updatedAt', 'Profile:User:update:updatedAt'],
    'a row and the rows nested three levels deep': [
      'Avatar:Avatar:update:updatedAt',
      'Avatar:Profile:update:updatedAt',
      'AvatarImage:Avatar:update:updatedAt',
      'AvatarImage:AvatarImage:update:updatedAt',
      'Profile:Profile:update:updatedAt',
      'Profile:User:update:updatedAt',
    ],
  };

  beforeAll(async () => {
    basePrisma = createBasePrisma();
    await basePrisma.$connect();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
  });

  describe.each(Object.keys(unchangedWrites) as Array<keyof typeof unchangedWrites>)('over %s', (shape) => {
    it.each(['upsert', 'update'] as const)(
      'records update logs whose only change is updatedAt when %s leaves updatedAt an ordinary field',
      async (operation) => {
        const user = await seedUser();
        const prisma = createClient(undefined);

        await provider.runAsync(testActor, () => unchangedWrites[shape][operation](prisma, user.id));

        expect(await recordedWrites()).toEqual(recordedWritesByShape[shape]);
      },
    );

    it.each(['upsert', 'update'] as const)(
      'records nothing when %s runs with updatedAt in the entities diffExcludeFields',
      async (operation) => {
        const user = await seedUser();
        const prisma = createClient(['updatedAt']);

        await provider.runAsync(testActor, () => unchangedWrites[shape][operation](prisma, user.id));

        expect(await basePrisma.auditLog.count()).toBe(0);
      },
    );
  });
});
