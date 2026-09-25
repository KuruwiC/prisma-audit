/**
 * Entity identity of a record whose primary key could not be determined (a primary-key field
 * is absent or null, or the lookup that would have produced the record failed). Nested
 * pre-fetch results store such a record under this key, and a lookup for a specific entityId
 * falls back to it. A symbol, so no primary-key value can equal it: consumers that need the
 * primary key read it from the stored record or treat the identity as unresolved.
 */
export const UNRESOLVED_ENTITY_ID: unique symbol = Symbol('UNRESOLVED_ENTITY_ID');

/** Entity identity of a record: its serialized primary key, or {@link UNRESOLVED_ENTITY_ID} */
export type EntityIdentityKey = string | typeof UNRESOLVED_ENTITY_ID;
