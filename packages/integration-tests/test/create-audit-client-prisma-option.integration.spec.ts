import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, type PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBasePrisma } from './helpers/setup.js';

describe('createAuditClient option validation', () => {
  let basePrisma: PrismaClient;

  beforeAll(() => {
    basePrisma = createBasePrisma();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
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
});
