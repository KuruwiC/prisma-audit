/**
 * Dynamic Include Injection Utilities
 *
 * Automatically injects deep `include` clauses into Prisma operations to ensure
 * nested write operations are captured in the result for audit logging.
 *
 * Analyzes operation args to detect nested write operations, builds an include tree,
 * and merges with user-provided includes (user includes take precedence).
 *
 * @module include-injection
 */

/**
 * Represents a nested write operation detected in args.data
 *
 * @internal
 */
interface NestedOperation {
  path: string[];
  operation: 'create' | 'update' | 'upsert' | 'connectOrCreate' | 'delete' | 'deleteMany';
  fieldName: string;
}

/**
 * Analyze upsert operation's nested data
 *
 * @internal
 */
const analyzeUpsertData = (nestedData: Record<string, unknown>, path: string[]): NestedOperation[] => {
  const operations: NestedOperation[] = [];
  const createData = nestedData.create;
  const updateData = nestedData.update;

  if (typeof createData === 'object' && createData !== null) {
    operations.push(...analyzeNestedWriteOperations(createData, path));
  }
  if (typeof updateData === 'object' && updateData !== null) {
    operations.push(...analyzeNestedWriteOperations(updateData, path));
  }

  return operations;
};

/**
 * Analyze connectOrCreate operation's nested data
 *
 * @internal
 */
const analyzeConnectOrCreateData = (nestedData: Record<string, unknown>, path: string[]): NestedOperation[] => {
  const createData = nestedData.create;
  if (typeof createData === 'object' && createData !== null) {
    return analyzeNestedWriteOperations(createData, path);
  }
  return [];
};

/**
 * Process a single write operation
 *
 * @internal
 */
const processWriteOperation = (
  op: 'create' | 'update' | 'upsert' | 'connectOrCreate' | 'delete' | 'deleteMany',
  key: string,
  value: Record<string, unknown>,
  path: string[],
): NestedOperation[] => {
  const operations: NestedOperation[] = [];
  const currentPath = [...path, key];

  operations.push({
    path: currentPath,
    operation: op,
    fieldName: key,
  });

  const nestedData = value[op];
  if (typeof nestedData !== 'object' || nestedData === null) {
    return operations;
  }

  const nestedDataRecord = nestedData as Record<string, unknown>;

  if (op === 'upsert') {
    operations.push(...analyzeUpsertData(nestedDataRecord, currentPath));
  } else if (op === 'connectOrCreate') {
    operations.push(...analyzeConnectOrCreateData(nestedDataRecord, currentPath));
  } else {
    operations.push(...analyzeNestedWriteOperations(nestedData, currentPath));
  }

  return operations;
};

/**
 * Recursively analyze args.data to detect all nested write operations
 */
export const analyzeNestedWriteOperations = (data: unknown, path: string[] = []): NestedOperation[] => {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const operations: NestedOperation[] = [];
  const writeOps = ['create', 'update', 'upsert', 'connectOrCreate', 'delete', 'deleteMany'] as const;

  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    for (const op of writeOps) {
      if (op in value) {
        operations.push(...processWriteOperation(op, key, value as Record<string, unknown>, path));
      }
    }
  }

  return operations;
};

/**
 * Check if there are deeper nested operations for a given path
 *
 * @internal
 */
const hasDeeperNested = (operations: readonly NestedOperation[], currentPath: readonly string[]): boolean => {
  const pathString = currentPath.join('.');
  return operations.some(
    (otherOp) =>
      otherOp.path.length > currentPath.length && otherOp.path.slice(0, currentPath.length).join('.') === pathString,
  );
};

/**
 * Process the last segment of a path in the include tree
 *
 * @internal
 */
const processLastSegment = (
  current: Record<string, unknown>,
  segment: string,
  operations: readonly NestedOperation[],
  currentPath: readonly string[],
): void => {
  const hasDeeper = hasDeeperNested(operations, currentPath);

  if (hasDeeper) {
    if (!current[segment]) {
      current[segment] = { include: {} };
    }
  } else {
    current[segment] = true;
  }
};

/**
 * Process an intermediate segment of a path in the include tree
 *
 * @internal
 */
const processIntermediateSegment = (current: Record<string, unknown>, segment: string): Record<string, unknown> => {
  if (!current[segment]) {
    current[segment] = { include: {} };
  }
  return (current[segment] as Record<string, unknown>).include as Record<string, unknown>;
};

/**
 * Build an include tree structure from nested operations
 *
 * Converts a flat list of nested operations into a nested include object
 * that Prisma can use to fetch the related records.
 */
export const buildIncludeTree = (operations: NestedOperation[]): Record<string, unknown> | undefined => {
  if (operations.length === 0) {
    return undefined;
  }

  const includeTree: Record<string, unknown> = {};

  for (const op of operations) {
    let current = includeTree;

    for (let i = 0; i < op.path.length; i++) {
      const segment = op.path[i];

      if (!segment) {
        continue;
      }

      const isLastSegment = i === op.path.length - 1;

      if (isLastSegment) {
        processLastSegment(current, segment, operations, op.path);
      } else {
        current = processIntermediateSegment(current, segment);
      }
    }
  }

  return includeTree;
};

/**
 * Check if both values are objects
 *
 * @internal
 */
const areBothObjects = (value1: unknown, value2: unknown): boolean => {
  return typeof value1 === 'object' && value1 !== null && typeof value2 === 'object' && value2 !== null;
};

/**
 * Merge nested includes recursively
 *
 * @internal
 */
const mergeNestedIncludes = (
  userValue: Record<string, unknown>,
  autoValue: Record<string, unknown>,
): Record<string, unknown> => {
  const autoValueInclude = autoValue.include;
  const userValueInclude = userValue.include;

  if (autoValueInclude && userValueInclude) {
    return {
      ...userValue,
      include: mergeIncludes(userValueInclude, autoValueInclude as Record<string, unknown>),
    };
  }

  if (autoValueInclude) {
    return {
      ...userValue,
      include: autoValueInclude,
    };
  }

  return userValue;
};

/**
 * Merge two include objects, with user-provided includes taking precedence
 */
export const mergeIncludes = (
  userInclude: unknown,
  autoInclude: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!autoInclude && !userInclude) {
    return undefined;
  }

  if (!autoInclude) {
    return userInclude as Record<string, unknown>;
  }

  if (!userInclude) {
    return autoInclude;
  }

  const merged: Record<string, unknown> = { ...(userInclude as Record<string, unknown>) };

  for (const [key, value] of Object.entries(autoInclude)) {
    if (!(key in merged)) {
      merged[key] = value;
    } else {
      const userValue = merged[key];

      if (areBothObjects(value, userValue)) {
        merged[key] = mergeNestedIncludes(userValue as Record<string, unknown>, value as Record<string, unknown>);
      }
    }
  }

  return merged;
};

/**
 * Inject deep include into operation args based on nested write operations
 *
 * Main entry point for the include injection feature.
 */
export const injectDeepInclude = (args: unknown): unknown => {
  if (!args || typeof args !== 'object') {
    return args;
  }

  const argsObj = args as Record<string, unknown>;

  // Analyze nested write operations in args.data
  const createData = argsObj.create;
  const updateData = argsObj.update;
  const dataToAnalyze = argsObj.data || updateData || createData;

  if (!dataToAnalyze) {
    return args;
  }

  const nestedOps = analyzeNestedWriteOperations(dataToAnalyze);

  if (nestedOps.length === 0) {
    return args;
  }

  // Build include tree from detected operations
  const autoInclude = buildIncludeTree(nestedOps);

  if (!autoInclude) {
    return args;
  }

  // Merge with user-provided include
  const mergedInclude = mergeIncludes(argsObj.include, autoInclude);

  return {
    ...argsObj,
    include: mergedInclude,
  };
};
