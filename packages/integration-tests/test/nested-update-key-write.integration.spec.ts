/**
 * Integration Test: a nested update that writes the row key of the row it updates
 *
 * A nested to-many write finds the row it updated, in the result or by a read after the write, by
 * the key the write gives it: the row key it had, with the key fields the data gives literal values
 * replaced. A `Device` identified by its `code` and a `Post` identified by its primary key are each
 * recorded under the key they have after the write. A write whose data changes the key in a way its
 * arguments do not tell, such as an operator on a key field, is not recorded and is reported as
 * `row-identification`.
 */

import type { AuditContext, AuditErrorObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, self } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-key-write-actor' },
};

/** The id a DeviceSensor is recorded under: its compound key, `deviceCode#slot` */
const sensorId = (sensor: unknown): string => {
  if (typeof sensor !== 'object' || sensor === null) {
    throw new TypeError('a DeviceSensor row is an object');
  }
  return `${String(Reflect.get(sensor, 'deviceCode'))}#${String(Reflect.get(sensor, 'slot'))}`;
};

describe('a nested update that writes the row key of the row it updates', () => {
  const disconnects: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async ({ fetchBeforeUpdate = true } = {}) => {
    const observer = vi.fn<AuditErrorObserver>();
    const basePrisma = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: {
        Device: defineEntity({ type: 'Device', idResolver: self('code') }),
        DeviceSensor: defineEntity({
          type: 'DeviceSensor',
          idResolver: self(sensorId),
        }),
        Post: defineEntity({ type: 'Post', idResolver: self() }),
      },
      fetchBefore: { update: fetchBeforeUpdate },
      write: { awaited: true },
      errorObserver: observer,
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const owner = await basePrisma.user.create({ data: { email: 'key-write-owner@example.com' } });
    const seedDevice = (code: string) =>
      basePrisma.device.create({ data: { code, label: `label of ${code}`, ownerId: owner.id } });
    const logsOf = async (entityType: string) =>
      (await basePrisma.auditLog.findMany({ where: { entityType }, orderBy: { entityId: 'asc' } })).map((log) => ({
        entityId: log.entityId,
        action: log.action,
        changes: log.changes,
        before: log.before,
      }));

    return { basePrisma, prisma, run, observer, owner, seedDevice, logsOf };
  };

  const recoded = {
    entityId: 'd-9',
    action: 'update',
    changes: { code: { old: 'd-1', new: 'd-9' }, label: { old: 'label of d-1', new: 'relabelled' } },
  };

  describe('a model identified by a unique field', () => {
    it.each([
      ['a value', 'd-9'],
      ['{ set }', { set: 'd-9' }],
    ])('records the device a nested update gives a new code as %s under that code', async (_label, code) => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { update: { where: { code: 'd-1' }, data: { code, label: 'relabelled' } } } },
        }),
      );

      expect(await logsOf('Device')).toEqual([
        { ...recoded, before: expect.objectContaining({ code: 'd-1', label: 'label of d-1' }) },
      ]);
      expect(observer).not.toHaveBeenCalled();
    });

    it('records the device a nested update gives a new code when the result selects none of the relation', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { update: { where: { code: 'd-1' }, data: { code: 'd-9', label: 'relabelled' } } } },
          select: { id: true },
        }),
      );

      expect(await logsOf('Device')).toEqual([expect.objectContaining(recoded)]);
      expect(observer).not.toHaveBeenCalled();
    });

    it('records the device a nested update gives a new code, named by its code, when the before state is not read', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup({ fetchBeforeUpdate: false });
      await seedDevice('d-1');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { update: { where: { code: 'd-1' }, data: { code: 'd-9', label: 'relabelled' } } } },
        }),
      );

      expect(await logsOf('Device')).toEqual([
        expect.objectContaining({ entityId: 'd-9', action: 'update', before: null }),
      ]);
      expect(observer).not.toHaveBeenCalled();
    });

    it('records the device the update branch of a nested upsert gives a new code under that code', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              upsert: {
                where: { code: 'd-1' },
                create: { code: 'd-1', label: 'new' },
                update: { code: 'd-9', label: 'relabelled' },
              },
            },
          },
        }),
      );

      expect(await logsOf('Device')).toEqual([expect.objectContaining(recoded)]);
      expect(observer).not.toHaveBeenCalled();
    });

    it('records the device a nested updateMany gives a new code under that code', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { updateMany: { where: { code: 'd-1' }, data: { code: 'd-9', label: 'relabelled' } } } },
        }),
      );

      expect(await logsOf('Device')).toEqual([expect.objectContaining(recoded)]);
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe('a model identified by its primary key', () => {
    it('records the post a nested update gives a new id under that id', async () => {
      const { prisma, basePrisma, run, observer, owner, logsOf } = await setup();
      const post = await basePrisma.post.create({ data: { title: 'T', authorId: owner.id } });

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { posts: { update: { where: { id: post.id }, data: { id: 'renamed-post', title: 'T2' } } } },
        }),
      );

      expect(await logsOf('Post')).toEqual([
        expect.objectContaining({
          entityId: 'renamed-post',
          action: 'update',
          changes: expect.objectContaining({
            id: { old: post.id, new: 'renamed-post' },
            title: { old: 'T', new: 'T2' },
          }),
        }),
      ]);
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe('a write that changes the key in a way its arguments do not tell', () => {
    it('does not record a sensor a nested update re-keys with an operator on a key field, and reports it', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: {
            sensors: {
              update: { where: { deviceCode_slot: { deviceCode: 'd-1', slot: 1 } }, data: { slot: { increment: 10 } } },
            },
          },
        }),
      );

      expect(await basePrisma.deviceSensor.findMany({ select: { deviceCode: true, slot: true } })).toEqual([
        { deviceCode: 'd-1', slot: 11 },
      ]);
      expect(await logsOf('DeviceSensor')).toEqual([]);
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'DeviceSensor',
          operation: 'update',
          params: { path: 'sensors', unidentified: 1 },
          error: expect.objectContaining({
            message:
              '1 of the rows a nested update at sensors wrote are not audited: its data changes their key in a way the audit cannot follow',
          }),
        }),
      );
    });
  });
});
