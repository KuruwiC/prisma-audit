/**
 * Integration Test: an enricher that falls back is reported, and drops no audit log entry
 *
 * An enricher whose failure its `onError` turns into the fallback (`'log'` or `'ignore'`) leaves
 * the entries recorded with the fallback in place of the context. The observer's
 * outcome stays `complete` and lists the failure once per enricher call, with
 * `phase: 'enrichment'` and the kind of the enricher, under `'ignore'` too; an `atomic` operation
 * commits.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, defineEntity, foreignKey, to } from '@kuruwic/db-audit-core';
import type { AuditObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'enrichment-failure-actor' },
};

describe('enrichment failures', () => {
  const context = setupTestContext();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(['log', 'ignore'] as const)("an enricher that falls back under onError '%s'", (onError) => {
    const failing = <TFallback>(error: Error, fallback: TFallback) => ({
      enricher: async (): Promise<never> => {
        throw error;
      },
      onError,
      fallback,
    });

    it.each(['awaited', 'atomic'] as const)(
      'is listed in a complete outcome with the kind of the enricher, and the entries are recorded with the fallback, %s',
      async (mode) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const actorError = new Error('actor lookup failed');
        const entityError = new Error('entity lookup failed');
        const aggregateError = new Error('aggregate lookup failed');
        const observer = vi.fn<AuditObserver>();
        const basePrisma = createBasePrisma();
        const provider = createAsyncLocalStorageProvider();
        const prisma = createAuditClient(basePrisma, {
          Prisma,
          schema: auditSchema,
          contextProvider: provider,
          entities: {
            ...testEntities,
            Post: defineEntity({
              type: 'Post',
              aggregates: [
                to('User', foreignKey('authorId'), {
                  aggregateContext: failing(aggregateError, [{ name: 'unknown author' }]),
                }),
              ],
              entityContext: failing(entityError, [{ title: 'unknown title' }]),
            }),
          },
          actorContext: failing(actorError, { role: 'unknown role' }),
          write: { mode },
          observer,
        });

        try {
          const author = await context.provider.runAsync(testActor, async () =>
            context.prisma.user.create({ data: { email: `enrichment-failure-${mode}@example.com`, name: 'Author' } }),
          );

          const post = await provider.runAsync(testActor, async () =>
            prisma.post.create({ data: { title: 'Enriched', authorId: author.id } }),
          );

          expect(observer.mock.calls).toEqual([
            [
              {
                model: 'Post',
                operation: 'create',
                status: 'complete',
                records: 2,
                failures: [
                  { phase: 'enrichment', enricher: 'actor', error: actorError },
                  { phase: 'enrichment', enricher: 'entity', error: entityError },
                  { phase: 'enrichment', enricher: 'aggregate', error: aggregateError },
                ],
                unrecordedWrites: [],
                isolation: { kind: mode === 'atomic' ? 'undeclared' : 'no-transaction' },
              },
            ],
          ]);
          const logs = await context.basePrisma.auditLog.findMany({
            where: { entityType: 'Post', entityId: post.id },
            select: { aggregateType: true, actorContext: true, entityContext: true, aggregateContext: true },
            orderBy: { aggregateType: 'asc' },
          });
          const actorContext = { role: 'unknown role' };
          const entityContext = { title: 'unknown title' };
          expect(logs).toEqual([
            { aggregateType: 'Post', actorContext, entityContext, aggregateContext: null },
            { aggregateType: 'User', actorContext, entityContext, aggregateContext: { name: 'unknown author' } },
          ]);
          if (onError === 'log') {
            expect(warn).toHaveBeenCalledWith('[db-audit-core] Enricher failed:', actorError);
          } else {
            expect(warn).not.toHaveBeenCalled();
          }
        } finally {
          await prisma.$disconnect();
          await basePrisma.$disconnect();
        }
      },
    );
  });
});
