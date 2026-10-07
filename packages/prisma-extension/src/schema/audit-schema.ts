/**
 * Audit Schema Contract
 *
 * The data `prisma-audit-generator` writes at `prisma generate` time and the extension reads at
 * runtime. The generator type-checks its output against this type, so a change here fails the
 * generator's compile.
 *
 * @module schema/audit-schema
 */

/** A primary key or unique constraint: its fields, and its name when the schema gives one */
interface AuditSchemaKey {
  readonly fields: readonly string[];
  readonly name: string | null;
}

/** A unique constraint: `@unique` on one field, or `@@unique` over several */
interface AuditSchemaUnique extends AuditSchemaKey {
  readonly type: 'uniqueField' | 'uniqueIndex';
}

interface AuditSchemaColumn {
  readonly name: string;
  readonly kind: 'scalar' | 'enum' | 'unsupported';
  readonly type: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly isId: boolean;
  readonly isUnique: boolean;
  readonly isUpdatedAt: boolean;
  /** True for any `@default`, function or literal */
  readonly hasDefaultValue: boolean;
  /** The function of a function default such as `uuid(7)`; null for a literal default or none */
  readonly default: { readonly name: string; readonly args: readonly (string | number)[] } | null;
}

interface AuditSchemaRelation<TModelName extends string = string> {
  readonly name: string;
  readonly kind: 'object';
  readonly relatedModel: TModelName;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly relationName: string;
  /** The fields of this model that hold the foreign key; empty when the related model holds it */
  readonly foreignKeyFields: readonly string[];
  /** The fields of the related model the foreign key references */
  readonly referencedFields: readonly string[];
}

type AuditSchemaField<TModelName extends string = string> = AuditSchemaColumn | AuditSchemaRelation<TModelName>;

interface AuditSchemaModel<TModelName extends string = string> {
  /** The model's name as declared in the schema; `@@map` is ignored */
  readonly name: TModelName;
  /** The model's fields in declaration order */
  readonly fields: readonly AuditSchemaField<TModelName>[];
  /** The `@@id`, else the `@id` field with a null name; null when the model has neither */
  readonly primaryKey: AuditSchemaKey | null;
  /** `@unique` fields in field order, then `@@unique` constraints in declaration order */
  readonly uniqueConstraints: readonly AuditSchemaUnique[];
}

/**
 * The schema data the generator emits: models in declaration order.
 *
 * `formatVersion` changes when the shape does; the runtime rejects a version it does not read.
 */
export interface AuditSchema<TModelName extends string = string> {
  readonly formatVersion: 1;
  readonly models: readonly AuditSchemaModel<TModelName>[];
}
