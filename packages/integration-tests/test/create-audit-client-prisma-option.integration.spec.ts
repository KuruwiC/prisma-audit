import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, type PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'client-options-actor' },
};

describe('createAuditClient with the Prisma namespace option', () => {
  let basePrisma: PrismaClient;

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

  it('refuses to build a client without the schema option, naming the steps that produce it', () => {
    // Options without `schema`, as a JavaScript caller or a configuration assembled at runtime passes them
    const options: Omit<PrismaAuditExtensionOptions, 'schema'> = {
      Prisma,
      contextProvider: createAsyncLocalStorageProvider(),
      entities: { User: defineEntity({ type: 'User' }) },
    };

    expect(() => createAuditClient(basePrisma, options as PrismaAuditExtensionOptions)).toThrow(
      [
        '[@prisma-audit] The "schema" option is missing. Add this generator block to schema.prisma:',
        '',
        'generator audit {',
        '  provider = "prisma-audit-generator"',
        '  output   = "../generated/audit"',
        '}',
        '',
        'then run `prisma generate` and pass `schema: auditSchema`, imported from that output.',
      ].join('\n'),
    );
  });

  it('audits a create on a plain PrismaClient', async () => {
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: {
        User: defineEntity({ type: 'User' }),
      },
      performance: { awaitWrite: true },
    });

    const user = await provider.runAsync(testActor, () =>
      prisma.user.create({ data: { email: 'client-options@example.com', name: 'Client Options' } }),
    );

    const auditLogs = await basePrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('create');
    expect(auditLogs[0]?.actorId).toBe('client-options-actor');
  });

  it('audits a create on a client already extended with $extends', async () => {
    const extendedClient = basePrisma.$extends({ name: 'unrelated-extension', query: {} });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(extendedClient, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: {
        User: defineEntity({ type: 'User' }),
      },
      performance: { awaitWrite: true },
    });

    const user = await provider.runAsync(testActor, () =>
      prisma.user.create({ data: { email: 'namespace-resolution@example.com', name: 'Namespace' } }),
    );

    const auditLogs = await basePrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('create');
    expect(auditLogs[0]?.actorId).toBe('client-options-actor');
  });
});
