/**
 * Prisma Client with Audit Extension for Hono API Example
 */

import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { getBasePrisma } from '@kuruwic/prisma-audit-database';
import auditConfig, { auditProvider } from './audit.config.js';

export { Prisma } from '@kuruwic/prisma-audit-database';
export { auditProvider };
export type { AuditContext };

export const prisma = createAuditClient(getBasePrisma(), auditConfig);

export type AuditedPrismaClient = typeof prisma;
