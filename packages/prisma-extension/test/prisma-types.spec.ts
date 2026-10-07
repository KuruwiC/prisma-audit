/**
 * Type-level tests for the row-type inference over a Prisma client
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { PrismaModelType } from '../src/prisma-types.js';

// Mirrors the shape of a generated client: model delegates expose findUnique, other members do not
interface MockPrismaClient {
  user: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; name: string | null } | null>;
  };
  avatarImage: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; avatarId: string } | null>;
  };
  $connect: () => Promise<void>;
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

describe('PrismaModelType', () => {
  it('is the row type the delegate returns, without null', () => {
    expectTypeOf<PrismaModelType<MockPrismaClient, 'AvatarImage'>>().toEqualTypeOf<{ id: string; avatarId: string }>();
  });
});
