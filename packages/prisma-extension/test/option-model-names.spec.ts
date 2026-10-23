/**
 * Type-level tests: the entity map takes its keys from the model names of the `schema` option,
 * spelled as the schema declares them
 */

import { createAsyncLocalStorageProvider, defineEntities, defineEntity } from '@kuruwic/db-audit-core';
import { describe, expectTypeOf, it } from 'vitest';
import { createAuditClient, defineConfig } from '../src/client-factory.js';
import type { AuditSchema } from '../src/schema/audit-schema.js';
import type { PrismaAuditExtensionOptions } from '../src/types.js';

type ModelName = 'User' | 'UserProfile';

// A client without model delegates: every model name the options accept comes from `schema`
interface MockPrismaClient {
  $extends: (extension: unknown) => MockPrismaClient;
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

const schema: AuditSchema<ModelName> = {
  formatVersion: 1,
  models: [
    { name: 'User', fields: [], primaryKey: { fields: ['id'], name: null }, uniqueConstraints: [] },
    { name: 'UserProfile', fields: [], primaryKey: { fields: ['id'], name: null }, uniqueConstraints: [] },
  ],
};

const base = {
  Prisma: { defineExtension: (extension: unknown) => extension, DbNull: null },
  schema,
  contextProvider: createAsyncLocalStorageProvider(),
};

const userProfile = defineEntity<{ id: string }, MockPrismaClient>({ type: 'UserProfile' });

describe('defineConfig', () => {
  it('infers the model names from schema and keeps the client given explicitly', () => {
    const config = defineConfig<MockPrismaClient>()({
      ...base,
      entities: { UserProfile: userProfile },
    });

    expectTypeOf(config).toEqualTypeOf<PrismaAuditExtensionOptions<ModelName, MockPrismaClient>>();
  });

  it('keys entities by the declared model names only', () => {
    const config = defineConfig<MockPrismaClient>()({ ...base, entities: {} });

    expectTypeOf(config.entities).toHaveProperty('UserProfile');
    expectTypeOf(config.entities).not.toHaveProperty('userProfile');
    expectTypeOf(config.entities).not.toHaveProperty('Comment');
  });

  it('rejects an entities key the schema does not declare', () => {
    defineConfig<MockPrismaClient>()({
      ...base,
      entities: {
        // @ts-expect-error Comment is not a model of the schema
        Comment: defineEntity({ type: 'Comment' }),
      },
    });
  });

  it('rejects an entities key in the delegate spelling', () => {
    defineConfig<MockPrismaClient>()({
      ...base,
      entities: {
        // @ts-expect-error the schema declares UserProfile, not the delegate's spelling
        userProfile,
      },
    });
  });

  it('accepts a mapping defined ahead with the schema model names', () => {
    const entities = defineEntities<ModelName, MockPrismaClient>()({ UserProfile: userProfile });

    expectTypeOf(defineConfig<MockPrismaClient>()({ ...base, entities })).toEqualTypeOf<
      PrismaAuditExtensionOptions<ModelName, MockPrismaClient>
    >();
  });
});

// Each client is built inside a function that is type-checked and never called: creating a client
// needs a real Prisma client
describe('createAuditClient', () => {
  it('infers the model names from schema and the client from prisma', () => {
    const build = (prisma: MockPrismaClient) =>
      createAuditClient(prisma, {
        ...base,
        entities: { UserProfile: userProfile },
      });

    expectTypeOf(build).returns.toExtend<MockPrismaClient>();
  });

  it('rejects an entities key the schema does not declare', () => {
    const build = (prisma: MockPrismaClient) =>
      createAuditClient(prisma, {
        ...base,
        entities: {
          // @ts-expect-error Comment is not a model of the schema
          Comment: defineEntity({ type: 'Comment' }),
        },
      });

    expectTypeOf(build).returns.toExtend<MockPrismaClient>();
  });

  it('accepts a configuration from defineConfig for the same client', () => {
    const config = defineConfig<MockPrismaClient>()({ ...base, entities: { UserProfile: userProfile } });
    const build = (prisma: MockPrismaClient) => createAuditClient(prisma, config);

    expectTypeOf(build).returns.toExtend<MockPrismaClient>();
  });
});

describe('a model name spelled unlike its delegate', () => {
  // `model user_profile` has the delegate `user_profile`; `Capitalize` of it is `User_profile`
  const snakeSchema: AuditSchema<'User' | 'user_profile'> = {
    formatVersion: 1,
    models: [
      { name: 'User', fields: [], primaryKey: { fields: ['id'], name: null }, uniqueConstraints: [] },
      { name: 'user_profile', fields: [], primaryKey: { fields: ['id'], name: null }, uniqueConstraints: [] },
    ],
  };
  const snakeBase = { ...base, schema: snakeSchema };

  it('keys the entities by the declared spelling', () => {
    const config = defineConfig<MockPrismaClient>()({
      ...snakeBase,
      entities: { user_profile: userProfile },
    });

    expectTypeOf(config).toEqualTypeOf<PrismaAuditExtensionOptions<'User' | 'user_profile', MockPrismaClient>>();
  });

  it('rejects entities keys in another spelling', () => {
    defineConfig<MockPrismaClient>()({
      ...snakeBase,
      entities: {
        // @ts-expect-error the schema declares user_profile, not its capitalized accessor
        User_profile: userProfile,
      },
    });
    defineConfig<MockPrismaClient>()({
      ...snakeBase,
      entities: {
        // @ts-expect-error the schema declares user_profile, not UserProfile
        UserProfile: userProfile,
      },
    });
  });
});
