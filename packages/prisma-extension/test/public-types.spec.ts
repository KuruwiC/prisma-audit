/**
 * Type-level tests for the package entry: the types a public option is written against are
 * importable from it
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { AuditRecord, PrismaAuditExtensionOptions, WriteContext } from '../src/index.js';

type Writer = NonNullable<NonNullable<PrismaAuditExtensionOptions<'User', { id: string }>['hooks']>['writer']>;

describe('package entry types', () => {
  it("exports the record and context types of hooks.writer's parameters", () => {
    expectTypeOf<Parameters<Writer>>().toEqualTypeOf<[AuditRecord[], WriteContext<{ id: string }>]>();
  });
});
