/**
 * Test Setup - Per-test database cleanup
 */

import { PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';

const basePrisma = new PrismaClient();

beforeEach(async () => {
  await basePrisma.auditLog.deleteMany();
  await basePrisma.commentAttachment.deleteMany();
  await basePrisma.postAttachment.deleteMany();
  await basePrisma.postTag.deleteMany();
  await basePrisma.avatarImage.deleteMany();
  await basePrisma.avatar.deleteMany();
  await basePrisma.profile.deleteMany();
  await basePrisma.attachment.deleteMany();
  await basePrisma.tag.deleteMany();
  await basePrisma.comment.deleteMany();
  await basePrisma.post.deleteMany();
  await basePrisma.user.deleteMany();
});

afterAll(async () => {
  console.log('Disconnecting Prisma client...');

  try {
    await basePrisma.$disconnect();
    await prisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma:', error);
  }

  console.log('Test cleanup complete');
});

export { prisma as testPrisma };
