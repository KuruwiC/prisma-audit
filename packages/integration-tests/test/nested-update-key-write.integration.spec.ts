/**
 * Integration Test: a nested update that writes the row key of the row it updates
 *
 * A nested to-many write finds the row it updated, in the result or by a read after the write, by
 * the key the write gives it: the row key it had, with the key fields the data gives literal values
 * replaced. A `Device` identified by its `code` and a `Post` identified by its primary key are each
 * recorded under the key they have after the write. A write whose data changes the key in a way its
 * arguments do not tell, such as an operator on a key field, is not recorded and is reported as
 * `row-identification`, and so are the rows inserted next to it without a generated key, and
 * targets the keys they have after the write cannot tell apart. A `DeviceSensor`, whose row key
 * holds the foreign key to its `Device`, is found under the device's code as it is after the write:
 * moved in by a `connect`, or re-keyed by `ON UPDATE CASCADE` when the device gets a new code.
 */

import type { AuditContext, AuditObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, self } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
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
    const observer = vi.fn<AuditObserver>();
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
      write: { mode: 'awaited' },
      observer,
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
      expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([]);
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
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'DeviceSensor',
          operation: 'update',
          unidentified: 1,
          error: expect.objectContaining({
            message:
              '1 of the rows a nested update at sensors wrote are not audited: its data changes their key in a way the audit cannot follow',
          }),
        }),
      ]);
    });

    it('does not record a sensor an operator re-keys as created next to a nested create, and reports the sensor the create inserts', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: {
            sensors: {
              create: { slot: 2, reading: 'reading 2' },
              update: { where: { deviceCode_slot: { deviceCode: 'd-1', slot: 1 } }, data: { slot: { increment: 10 } } },
            },
          },
        }),
      );

      expect(
        await basePrisma.deviceSensor.findMany({ select: { deviceCode: true, slot: true }, orderBy: { slot: 'asc' } }),
      ).toEqual([
        { deviceCode: 'd-1', slot: 2 },
        { deviceCode: 'd-1', slot: 11 },
      ]);
      expect(await logsOf('DeviceSensor')).toEqual([]);
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'DeviceSensor',
          operation: 'update',
          unidentified: 1,
          error: expect.objectContaining({ message: expect.stringContaining('a nested update at sensors') }),
        }),
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'DeviceSensor',
          operation: 'create',
          unidentified: 1,
          error: expect.objectContaining({
            message:
              '1 of the rows a nested create at sensors wrote are not audited: they cannot be told apart from a row whose key the write changed in a way the audit cannot follow',
          }),
        }),
      ]);
    });
  });

  describe('targets at one path that the keys they have after the write cannot tell apart', () => {
    it('does not record the sensors nested updates move onto keys another update names or gives, and reports them', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 2, reading: 'reading 2' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: {
            sensors: {
              update: [
                { where: { deviceCode_slot: { deviceCode: 'd-1', slot: 1 } }, data: { slot: 3 } },
                { where: { deviceCode_slot: { deviceCode: 'd-1', slot: 3 } }, data: { slot: 4 } },
                { where: { deviceCode_slot: { deviceCode: 'd-1', slot: 2 } }, data: { slot: 3 } },
              ],
            },
          },
        }),
      );

      expect(
        await basePrisma.deviceSensor.findMany({ select: { slot: true, reading: true }, orderBy: { slot: 'asc' } }),
      ).toEqual([
        { slot: 3, reading: 'reading 2' },
        { slot: 4, reading: 'reading 1' },
      ]);
      expect(await logsOf('DeviceSensor')).toEqual([]);
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'DeviceSensor',
          operation: 'update',
          unidentified: 3,
          error: expect.objectContaining({ message: expect.stringContaining('at sensors') }),
        }),
      ]);
    });

    it('records the device a nested create inserts with a generated code next to updates that move devices onto the codes of one another', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');

      const updated = await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              create: { label: 'created' },
              update: [
                { where: { code: 'd-2' }, data: { code: 'd-3' } },
                { where: { code: 'd-1' }, data: { code: 'd-2' } },
              ],
            },
          },
          include: { devices: true },
        }),
      );

      const created = updated.devices.find((device) => device.label === 'created');
      expect(await logsOf('Device')).toEqual([expect.objectContaining({ entityId: created?.code, action: 'create' })]);
      expect(failuresOf(observer)).toEqual([
        expect.objectContaining({
          phase: 'row-identification',
          modelName: 'Device',
          operation: 'update',
          unidentified: 2,
          error: expect.objectContaining({ message: expect.stringContaining('at devices') }),
        }),
      ]);
    });
  });

  describe('a row key that holds the foreign key to the parent row', () => {
    const moved = {
      entityId: 'd-2#1',
      action: 'update',
      changes: { deviceCode: { old: 'd-1', new: 'd-2' } },
      before: expect.objectContaining({ deviceCode: 'd-1', slot: 1 }),
    };

    it('records a sensor a nested connect moves in from another device as the change of its device code, under the key it has after the write', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-2' },
          data: { sensors: { connect: { deviceCode_slot: { deviceCode: 'd-1', slot: 1 } } } },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([moved]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a sensor a nested connect moves in next to a nested create, and the created sensor, each under the key it has after the write', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-2' },
          data: {
            sensors: {
              create: { slot: 2, reading: 'reading 2' },
              connect: { deviceCode_slot: { deviceCode: 'd-1', slot: 1 } },
            },
          },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([
        moved,
        expect.objectContaining({ entityId: 'd-2#2', action: 'create' }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    const cascaded = {
      entityId: 'd-9#1',
      action: 'update',
      changes: { deviceCode: { old: 'd-1', new: 'd-9' }, reading: { old: 'reading 1', new: 'changed' } },
      before: expect.objectContaining({ deviceCode: 'd-1', slot: 1, reading: 'reading 1' }),
    };

    it('records a sensor a nested updateMany writes below a device the same update gives a new code, under the key the cascade gives it', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: { code: 'd-9', sensors: { updateMany: { where: { slot: 1 }, data: { reading: 'changed' } } } },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([cascaded]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a sensor a nested updateMany writes below a device given a new code when the result selects none of the relation', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: { code: 'd-9', sensors: { updateMany: { where: { slot: 1 }, data: { reading: 'changed' } } } },
          select: { code: true },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([cascaded]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a sensor a nested updateMany writes below a device a nested update gives a new code', async () => {
      const { prisma, basePrisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              update: {
                where: { code: 'd-1' },
                data: { code: 'd-9', sensors: { updateMany: { where: { slot: 1 }, data: { reading: 'changed' } } } },
              },
            },
          },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([cascaded]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a sensor a nested update names by the new code of its device, with the before state it had under the old code', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: {
            code: 'd-9',
            sensors: {
              update: { where: { deviceCode_slot: { deviceCode: 'd-9', slot: 1 } }, data: { reading: 'changed' } },
            },
          },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([cascaded]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a sensor a nested update names by the new code a nested update gives its device, with the before state it had under the old code', async () => {
      const { prisma, basePrisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              update: {
                where: { code: 'd-1' },
                data: {
                  code: 'd-9',
                  sensors: {
                    update: {
                      where: { deviceCode_slot: { deviceCode: 'd-9', slot: 1 } },
                      data: { reading: 'changed' },
                    },
                  },
                },
              },
            },
          },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([cascaded]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records the update branch of a nested upsert that names a sensor by the new code of its device, with the before state it had under the old code', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: {
            code: 'd-9',
            sensors: {
              upsert: {
                where: { deviceCode_slot: { deviceCode: 'd-9', slot: 1 } },
                create: { slot: 1, reading: 'created' },
                update: { reading: 'changed' },
              },
            },
          },
        }),
      );

      expect(
        await basePrisma.deviceSensor.findMany({ select: { deviceCode: true, slot: true, reading: true } }),
      ).toEqual([{ deviceCode: 'd-9', slot: 1, reading: 'changed' }]);
      expect(await logsOf('DeviceSensor')).toEqual([cascaded]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('does not record a sensor the new code of its device re-keys as created next to a nested create', async () => {
      const { prisma, basePrisma, run, observer, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await basePrisma.deviceSensor.create({ data: { deviceCode: 'd-1', slot: 1, reading: 'reading 1' } });

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: { code: 'd-9', sensors: { create: { slot: 2, reading: 'reading 2' } } },
        }),
      );

      expect(await logsOf('DeviceSensor')).toEqual([expect.objectContaining({ entityId: 'd-9#2', action: 'create' })]);
      expect(failuresOf(observer)).toEqual([]);
    });
  });
});
