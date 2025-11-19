/**
 * DMMF mapping type definition for type safety
 * Based on Prisma's internal DMMF structure
 */
interface DMMFModelMapping {
  model: string;
  plural: string;
  findUnique?: string;
  findFirst?: string;
  findMany?: string;
  create?: string;
  createMany?: string;
  update?: string;
  updateMany?: string;
  upsert?: string;
  delete?: string;
  deleteMany?: string;
  aggregate?: string;
  groupBy?: string;
  count?: string;
}

/**
 * DMMF mappings structure
 */
interface DMMFMappings {
  modelOperations?: DMMFModelMapping[];
}

/**
 * DMMF structure accessible via client._dmmf
 */
interface DMMF {
  mappings?: DMMFMappings;
}

/**
 * Client with internal DMMF accessor
 * Note: _dmmf is internal API but stable across versions
 * Accepts any client-like object (PrismaClient, extended client, transaction client)
 */
interface ClientWithDMMF {
  _dmmf?: DMMF;
}

/**
 * Type guard to check if client has DMMF
 *
 * @internal
 */
const hasDMMF = (client: unknown): client is ClientWithDMMF => {
  return (
    typeof client === 'object' &&
    client !== null &&
    '_dmmf' in client &&
    typeof (client as { _dmmf: unknown })._dmmf === 'object' &&
    (client as { _dmmf: unknown })._dmmf !== null
  );
};

/**
 * Type guard to check if value is a valid DMMF mapping
 *
 * @internal
 */
const isDMMFMapping = (value: unknown): value is DMMFModelMapping => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'model' in value &&
    typeof (value as { model: unknown }).model === 'string'
  );
};

/**
 * Get the correct model accessor name from DMMF
 *
 * Handles naming conventions like camelCase, PascalCase, snake_case.
 * Accepts any Prisma client-like object (base client, extended client, transaction client).
 *
 * @example
 * ```typescript
 * const accessor = getModelAccessor(prisma, 'User');
 * const users = await prisma[accessor].findMany();
 * ```
 */
export const getModelAccessor = (client: unknown, modelName: string): string => {
  const fallbackAccessor = (name: string): string => {
    return name.charAt(0).toLowerCase() + name.slice(1);
  };

  try {
    if (!hasDMMF(client)) {
      return fallbackAccessor(modelName);
    }

    const dmmf = client._dmmf;

    if (!dmmf?.mappings?.modelOperations) {
      return fallbackAccessor(modelName);
    }

    const mapping = dmmf.mappings.modelOperations.find(
      (m): m is DMMFModelMapping => isDMMFMapping(m) && m.model === modelName,
    );

    if (!mapping) {
      return fallbackAccessor(modelName);
    }

    return mapping.plural || mapping.model;
  } catch {
    return fallbackAccessor(modelName);
  }
};
