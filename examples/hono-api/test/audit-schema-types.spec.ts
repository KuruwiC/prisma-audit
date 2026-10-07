/**
 * Type-level tests for the audit schema generated from the database package's schema.prisma
 *
 * The generated declaration file imports its contract type from `@kuruwic/prisma-audit`. With
 * `skipLibCheck`, an import that does not resolve turns `auditSchema` into `any` without an error,
 * and every model-name check on the options goes with it.
 */

import type { AuditSchema } from '@kuruwic/prisma-audit';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { describe, expectTypeOf, it } from 'vitest';

describe('generated audit schema types', () => {
  it('names the models as a union of their declared names', () => {
    expectTypeOf<AuditModelName>().not.toBeAny();
    expectTypeOf<'User' | 'PostBookmark' | 'AuditLog'>().toExtend<AuditModelName>();
    expectTypeOf<string>().not.toExtend<AuditModelName>();
  });

  it('types auditSchema with the contract over those names', () => {
    expectTypeOf(auditSchema).not.toBeAny();
    expectTypeOf(auditSchema).toEqualTypeOf<AuditSchema<AuditModelName>>();
  });
});
