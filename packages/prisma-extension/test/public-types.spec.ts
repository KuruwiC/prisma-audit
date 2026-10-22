/**
 * Type-level tests for the package entry: the types a public option is written against are
 * importable from it
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  AuditContextProvider,
  AuditRecord,
  EntityMap,
  PrismaAuditExtensionOptions,
  WriteContext,
} from '../src/index.js';

type Options = PrismaAuditExtensionOptions<'User', { id: string }>;
type Writer = NonNullable<NonNullable<Options['write']>['writer']>;

describe('package entry types', () => {
  it("exports the record and context types of write.writer's parameters", () => {
    expectTypeOf<Parameters<Writer>>().toEqualTypeOf<[AuditRecord[], WriteContext<{ id: string }>]>();
  });

  it('exports the types of entities and contextProvider', () => {
    expectTypeOf<Options['entities']>().toEqualTypeOf<EntityMap<'User', { id: string }>>();
    expectTypeOf<Options['contextProvider']>().toEqualTypeOf<AuditContextProvider>();
  });

  it("passes the client to actorContext's enricher", () => {
    type ActorEnricher = NonNullable<Options['actorContext']>['enricher'];
    expectTypeOf<Parameters<ActorEnricher>[1]>().toEqualTypeOf<{ id: string }>();
  });
});
