import type { PrismaHandle } from '../internal-types.js';
import { uncapitalizeFirst } from './extension-utils.js';

/**
 * The client property of a model: its name with the first letter lowercased. Prisma exposes every
 * model under that property, whichever case the schema declares the model in; a name already in
 * that form is returned unchanged.
 *
 * @example
 * ```typescript
 * getModelAccessor('UuidV7Item'); // => 'uuidV7Item'
 * getModelAccessor('auditEvent'); // => 'auditEvent'
 * ```
 */
export const getModelAccessor = (modelName: string): string => uncapitalizeFirst(modelName);

export const getModelDelegate = (client: PrismaHandle, modelName: string): unknown =>
  client[getModelAccessor(modelName)];

const getModelOperation = (delegate: unknown, operation: string): ((args: unknown) => Promise<unknown>) | undefined => {
  if (typeof delegate !== 'object' || delegate === null) {
    return undefined;
  }
  const method = (delegate as Record<string, unknown>)[operation];
  return typeof method === 'function' ? (method as (args: unknown) => Promise<unknown>) : undefined;
};

/**
 * Whether `delegate` is an object whose `operation` property is a function. Narrows to
 * `TDelegate`, the shape the caller invokes the operation through.
 */
export const hasOperation = <TDelegate extends object>(delegate: unknown, operation: string): delegate is TDelegate =>
  getModelOperation(delegate, operation) !== undefined;
