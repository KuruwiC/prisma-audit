/**
 * The words that tie text to an ORM. @kuruwic/db-audit-core is ORM-independent: its source
 * (`check-core-invariants.mjs`) and the Core contract section of docs/guarantees.md
 * (`check-guarantees.mjs`) are checked against these.
 */

export const ORM_NAME = /prisma|drizzle/gi;

/** ORM operation names; `where`, `include` and `select` are ordinary English words and are not listed */
export const ORM_VOCABULARY =
  /\b(findUnique|findMany|findFirst|connectOrCreate|createMany|updateMany|deleteMany|createManyAndReturn|updateManyAndReturn|upsert|dmmf|DMMF)\b/g;
