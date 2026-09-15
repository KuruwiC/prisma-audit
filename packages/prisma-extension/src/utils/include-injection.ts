/**
 * Dynamic Include Injection Utilities
 *
 * Nested writes are audited from the records the operation returns, so the relations an operation
 * writes are injected into its `include`. The written relations come from core
 * `detectNestedOperations` in the discovery pass, which scans every branch the operation could
 * execute (both branches of an upsert). User-provided includes take precedence when merged.
 *
 * @module include-injection
 */

import { detectNestedOperations, type NestedOperationKeyword, type SchemaMetadata } from '@kuruwic/prisma-audit-core';

/**
 * Nested write keywords whose written rows are audited from the operation result. Deleted rows are
 * audited from their pre-fetched state, `connect` writes no row of the related model, and
 * `updateMany` rows are not read from the result.
 */
const RESULT_AUDITED_KEYWORDS: ReadonlySet<NestedOperationKeyword> = new Set([
  'create',
  'createMany',
  'update',
  'upsert',
  'connectOrCreate',
]);

/** Relation fields written at one level of the operation, each with the relations written below it */
type WrittenRelationTree = Map<string, WrittenRelationTree>;

/**
 * Build the tree of written relations from nested operation paths (e.g. `posts`, `posts.comments`)
 *
 * @internal
 */
const buildWrittenRelationTree = (paths: readonly string[]): WrittenRelationTree => {
  const root: WrittenRelationTree = new Map();

  for (const path of paths) {
    let level = root;
    for (const segment of path.split('.')) {
      let children = level.get(segment);
      if (!children) {
        children = new Map();
        level.set(segment, children);
      }
      level = children;
    }
  }

  return root;
};

/**
 * Convert a written-relation tree into a Prisma `include` object
 *
 * @internal
 */
const buildIncludeTree = (tree: WrittenRelationTree): Record<string, unknown> =>
  Object.fromEntries(
    Array.from(tree, ([field, children]) => [
      field,
      children.size === 0 ? true : { include: buildIncludeTree(children) },
    ]),
  );

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
 * Inject an include for the relations the operation writes
 *
 * Main entry point for the include injection feature.
 *
 * @param schemaMetadata - Schema metadata of the audited client
 * @param modelName - Model the operation runs on
 * @param args - Operation args
 * @returns The args with the written relations merged into `include`, or `args` itself when the
 *   operation writes no relation whose rows are audited from the result
 */
export const injectDeepInclude = (schemaMetadata: SchemaMetadata, modelName: string, args: unknown): unknown => {
  if (!args || typeof args !== 'object') {
    return args;
  }

  const argsObj = args as Record<string, unknown>;

  const writtenPaths = detectNestedOperations(schemaMetadata, modelName, argsObj, { kind: 'discovery' })
    .filter((operation) => RESULT_AUDITED_KEYWORDS.has(operation.operation))
    .map((operation) => operation.path);

  if (writtenPaths.length === 0) {
    return args;
  }

  return {
    ...argsObj,
    include: mergeIncludes(argsObj.include, buildIncludeTree(buildWrittenRelationTree(writtenPaths))),
  };
};
