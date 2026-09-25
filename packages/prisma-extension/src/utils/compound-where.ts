import type { UniqueConstraint } from '../schema/types.js';
/**
 * Compound-unique WHERE handling
 *
 * @module utils/compound-where
 */

/**
 * Unwraps Prisma's compound-unique WHERE wrapper (`{ a_b: { a, b } }`) into the flat
 * scalar record needed to derive an entityId from a WHERE clause.
 *
 * `findUnique` requires a composite primary key to be addressed through a single
 * generated key on `<Model>WhereUniqueInput` — `pkConstraint.name` when the key has an
 * explicit name (`@@id([a, b], name: "custom")`), or `fields.join('_')` (Prisma's default
 * naming) otherwise. A single-field PK, or a WHERE clause that isn't wrapped this way, is
 * returned unchanged.
 */
export const unwrapCompoundWhere = (
  whereClause: Record<string, unknown>,
  pkConstraint?: UniqueConstraint,
): Record<string, unknown> => {
  if (!pkConstraint || pkConstraint.fields.length <= 1) return whereClause;

  const compoundKey = pkConstraint.name ?? pkConstraint.fields.join('_');
  return (whereClause[compoundKey] as Record<string, unknown> | undefined) ?? whereClause;
};
