/**
 * Integration Test: nested writes to models with no primary key, identified by unique constraints
 *
 * `Device` is identified by `code String @unique` and `DeviceSensor` by
 * `@@unique([deviceCode, slot])`, a compound key under a `Device`. Nested writes into them, and
 * nested writes below a `Device`, name each row by that row key: every create, update, upsert,
 * delete, updateMany, deleteMany, connect, disconnect, set and connectOrCreate records one log per
 * row it writes, under the row's key, with the changes it made.
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
  actor: { category: 'model', type: 'User', id: 'unique-only-nested-actor' },
};

/** The id a DeviceSensor is recorded under: its compound key, `deviceCode#slot` */
const sensorId = (sensor: unknown): string => {
  if (typeof sensor !== 'object' || sensor === null) {
    throw new TypeError('a DeviceSensor row is an object');
  }
  return `${String(Reflect.get(sensor, 'deviceCode'))}#${String(Reflect.get(sensor, 'slot'))}`;
};

describe('nested writes to models identified by a unique constraint instead of a primary key', () => {
  const disconnects: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async () => {
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
      },
      write: { mode: 'awaited' },
      observer,
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const owner = await basePrisma.user.create({ data: { email: 'device-owner@example.com' } });
    const other = await basePrisma.user.create({ data: { email: 'device-other@example.com' } });
    const seedDevice = (code: string, ownerId: string | null = owner.id) =>
      basePrisma.device.create({ data: { code, label: `label of ${code}`, ownerId } });
    const seedSensor = (deviceCode: string, slot: number) =>
      basePrisma.deviceSensor.create({ data: { deviceCode, slot, reading: `reading ${slot}` } });
    /** Every log of a Device or a DeviceSensor, sorted by entity type, entity id and action */
    const logsOf = async () =>
      (
        await basePrisma.auditLog.findMany({
          where: { entityType: { in: ['Device', 'DeviceSensor'] } },
          orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }, { action: 'asc' }],
        })
      ).map((log) => ({
        entityType: log.entityType,
        entityId: log.entityId,
        action: log.action,
        changes: log.changes,
        before: log.before,
        after: log.after,
      }));
    const actionsOf = async () => (await logsOf()).map((log) => [log.entityType, log.entityId, log.action]);

    return { basePrisma, prisma, run, observer, owner, other, seedDevice, seedSensor, logsOf, actionsOf };
  };

  describe('a nested write into a model identified by a unique field', () => {
    it('records a create log per device a nested to-many create inserts under an existing row, under the code it was given or generated', async () => {
      const { prisma, basePrisma, run, observer, owner, seedDevice, actionsOf } = await setup();
      await seedDevice('d-existing');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { create: [{ code: 'd-given', label: 'given' }, { label: 'generated' }] } },
        }),
      );

      const generated = await basePrisma.device.findFirstOrThrow({ where: { label: 'generated' } });
      expect(await actionsOf()).toEqual(
        [
          ['Device', 'd-given', 'create'],
          ['Device', generated.code, 'create'],
        ].sort(),
      );
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a create log per device a nested createMany inserts under an existing row', async () => {
      const { prisma, run, observer, owner, actionsOf } = await setup();

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              createMany: {
                data: [
                  { code: 'd-1', label: 'one' },
                  { code: 'd-2', label: 'two' },
                ],
              },
            },
          },
        }),
      );

      expect(await actionsOf()).toEqual([
        ['Device', 'd-1', 'create'],
        ['Device', 'd-2', 'create'],
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a create log per device a nested create inserts under a row the operation creates', async () => {
      const { prisma, run, observer, actionsOf } = await setup();

      await run(() =>
        prisma.user.create({
          data: { email: 'new-owner@example.com', devices: { create: [{ code: 'd-1', label: 'one' }] } },
        }),
      );

      expect(await actionsOf()).toEqual([['Device', 'd-1', 'create']]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records an update log, with its before state, for the device a nested update names by its code', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { update: { where: { code: 'd-1' }, data: { label: 'relabelled' } } } },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityType: 'Device',
          entityId: 'd-1',
          action: 'update',
          changes: { label: { old: 'label of d-1', new: 'relabelled' } },
          before: expect.objectContaining({ code: 'd-1', label: 'label of d-1' }),
          after: expect.objectContaining({ code: 'd-1', label: 'relabelled' }),
        }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records the update of a device a nested update writes when the result selects none of the relation', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { update: { where: { code: 'd-1' }, data: { label: 'relabelled' } } } },
          select: { id: true },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityId: 'd-1',
          action: 'update',
          changes: { label: { old: 'label of d-1', new: 'relabelled' } },
        }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records an upsert as an update of the device its code names, and as a create when there is none', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              upsert: [
                { where: { code: 'd-1' }, create: { code: 'd-1', label: 'new' }, update: { label: 'relabelled' } },
                { where: { code: 'd-2' }, create: { code: 'd-2', label: 'created' }, update: { label: 'relabelled' } },
              ],
            },
          },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityId: 'd-1',
          action: 'update',
          changes: { label: { old: 'label of d-1', new: 'relabelled' } },
        }),
        expect.objectContaining({
          entityId: 'd-2',
          action: 'create',
          after: expect.objectContaining({ code: 'd-2', label: 'created' }),
        }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a delete log, with its before state, for the device a nested delete names by its code', async () => {
      const { prisma, basePrisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');

      await run(() => prisma.user.update({ where: { id: owner.id }, data: { devices: { delete: { code: 'd-1' } } } }));

      expect(await basePrisma.device.count()).toBe(1);
      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityId: 'd-1',
          action: 'delete',
          before: expect.objectContaining({ code: 'd-1', label: 'label of d-1' }),
        }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records one log per device a nested updateMany and deleteMany write', async () => {
      const { prisma, run, observer, owner, other, seedDevice, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');
      await seedDevice('d-3');
      await seedDevice('d-other', other.id);

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              updateMany: { where: { code: { in: ['d-1', 'd-2', 'd-other'] } }, data: { label: 'relabelled' } },
              deleteMany: { code: 'd-3' },
            },
          },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityId: 'd-1',
          action: 'update',
          changes: { label: { old: 'label of d-1', new: 'relabelled' } },
        }),
        expect.objectContaining({
          entityId: 'd-2',
          action: 'update',
          changes: { label: { old: 'label of d-2', new: 'relabelled' } },
        }),
        expect.objectContaining({ entityId: 'd-3', action: 'delete' }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records the foreign-key change of each device a connect, disconnect and set re-link', async () => {
      const { prisma, run, observer, owner, other, seedDevice, logsOf } = await setup();
      await seedDevice('d-kept');
      await seedDevice('d-dropped');
      await seedDevice('d-moved', other.id);
      await seedDevice('d-loose', null);

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: { devices: { set: [{ code: 'd-kept' }, { code: 'd-moved' }] } },
        }),
      );
      await run(() =>
        prisma.user.update({
          where: { id: other.id },
          data: { devices: { connect: { code: 'd-loose' } } },
        }),
      );
      await run(() =>
        prisma.user.update({
          where: { id: other.id },
          data: { devices: { disconnect: { code: 'd-loose' } } },
        }),
      );

      const logs = await logsOf();
      // The two d-loose rows tie on the ordering of `logsOf`, so both sides are put in one order first
      type Row = [string, string, { ownerId: { old: string | null; new: string | null } }];
      const keyOf = ([entityId, , changes]: Row) => `${entityId}|${changes.ownerId.old}|${changes.ownerId.new}`;
      const byKey = (a: Row, b: Row) => keyOf(a).localeCompare(keyOf(b));
      expect(logs.map((log) => [log.entityId, log.action, log.changes] as Row).sort(byKey)).toEqual(
        (
          [
            ['d-dropped', 'update', { ownerId: { old: owner.id, new: null } }],
            ['d-loose', 'update', { ownerId: { old: null, new: other.id } }],
            ['d-loose', 'update', { ownerId: { old: other.id, new: null } }],
            ['d-moved', 'update', { ownerId: { old: other.id, new: owner.id } }],
          ] as Row[]
        ).sort(byKey),
      );
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records a connectOrCreate as the link change of the device its code names, and as a create when there is none', async () => {
      const { prisma, run, observer, owner, seedDevice, logsOf } = await setup();
      await seedDevice('d-1', null);

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              connectOrCreate: [
                { where: { code: 'd-1' }, create: { code: 'd-1', label: 'new' } },
                { where: { code: 'd-2' }, create: { code: 'd-2', label: 'created' } },
              ],
            },
          },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityId: 'd-1',
          action: 'update',
          changes: { ownerId: { old: null, new: owner.id } },
        }),
        expect.objectContaining({
          entityId: 'd-2',
          action: 'create',
          after: expect.objectContaining({ code: 'd-2', label: 'created', ownerId: owner.id }),
        }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });
  });

  describe('a nested write into a model identified by a compound unique constraint, below a device', () => {
    it('records the create, update and delete of sensors written below a device, each under its compound key', async () => {
      const { prisma, run, observer, seedDevice, seedSensor, logsOf } = await setup();
      await seedDevice('d-1');
      await seedSensor('d-1', 1);
      await seedSensor('d-1', 2);

      await run(() =>
        prisma.device.update({
          where: { code: 'd-1' },
          data: {
            sensors: {
              create: { slot: 3, reading: 'reading 3' },
              update: { where: { deviceCode_slot: { deviceCode: 'd-1', slot: 1 } }, data: { reading: 'changed' } },
              delete: { deviceCode_slot: { deviceCode: 'd-1', slot: 2 } },
            },
          },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityType: 'DeviceSensor',
          entityId: 'd-1#1',
          action: 'update',
          changes: { reading: { old: 'reading 1', new: 'changed' } },
        }),
        expect.objectContaining({
          entityType: 'DeviceSensor',
          entityId: 'd-1#2',
          action: 'delete',
          before: expect.objectContaining({ deviceCode: 'd-1', slot: 2, reading: 'reading 2' }),
        }),
        expect.objectContaining({ entityType: 'DeviceSensor', entityId: 'd-1#3', action: 'create' }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });

    it('records the writes two levels down, below a device a nested update names by its code', async () => {
      const { prisma, run, observer, owner, seedDevice, seedSensor, logsOf } = await setup();
      await seedDevice('d-1');
      await seedDevice('d-2');
      await seedSensor('d-1', 1);
      await seedSensor('d-2', 1);

      await run(() =>
        prisma.user.update({
          where: { id: owner.id },
          data: {
            devices: {
              update: {
                where: { code: 'd-1' },
                data: {
                  label: 'relabelled',
                  sensors: {
                    create: { slot: 2, reading: 'reading 2' },
                    updateMany: { where: { slot: 1 }, data: { reading: 'changed' } },
                  },
                },
              },
            },
          },
        }),
      );

      expect(await logsOf()).toEqual([
        expect.objectContaining({
          entityType: 'Device',
          entityId: 'd-1',
          action: 'update',
          changes: { label: { old: 'label of d-1', new: 'relabelled' } },
        }),
        expect.objectContaining({
          entityType: 'DeviceSensor',
          entityId: 'd-1#1',
          action: 'update',
          changes: { reading: { old: 'reading 1', new: 'changed' } },
        }),
        expect.objectContaining({
          entityType: 'DeviceSensor',
          entityId: 'd-1#2',
          action: 'create',
          after: expect.objectContaining({ deviceCode: 'd-1', slot: 2, reading: 'reading 2' }),
        }),
      ]);
      expect(failuresOf(observer)).toEqual([]);
    });
  });
});
