import type { PrismaClient } from '@kuruwic/prisma-audit-database';

/**
 * Setup benchmark database
 * Note: This assumes the database schema is already migrated
 * Run `pnpm --filter @kuruwic/prisma-audit-database db:push` before benchmarking
 */
export const setupBenchmarkDb = async (prisma: PrismaClient): Promise<void> => {
  // Clean up existing data
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
};

export const seedBenchmarkData = async (prisma: PrismaClient): Promise<void> => {
  // Create 100 users for benchmark
  await prisma.user.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({
      email: `user${i}@example.com`,
      name: `User ${i}`,
    })),
  });
};
