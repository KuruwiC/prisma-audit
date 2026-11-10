/**
 * Write Structure
 *
 * Which relations an operation's arguments write, how many rows and in what order, apart from the
 * values written and the values and fields that pick rows. Each nested write the discovery pass of
 * {@link detectNestedOperations} finds is located by where the arguments hold it (both upsert
 * branches told apart: `create.posts.create`, `posts.upsert[0].update.tags.create`) and carries its
 * related model, element count, the keywords listed before it in its relation field, and the
 * `true` / `false` of a to-one delete or disconnect; a top-level createMany adds its row count.
 * Row-picking values and fields (the top-level `where`, the unique WHERE, nested filters) are
 * excluded: keeping them consistent between reads and writes is up to whoever changes them, as a
 * deterministic encryption of a unique field or a tenant filter adding a field to every WHERE
 * alike does. The caller reads the arguments as Prisma sends them (`utils/arguments-as-sent.ts`).
 *
 * @module grammar/write-structure
 */

import type { SchemaMetadata } from '../schema/types.js';
import { isRecord } from '../utils/is-record.js';
import {
  detectNestedOperations,
  elementsOf,
  type NestedOperationInfo,
  type UpsertBranch,
} from './nested-operations.js';

/** One write of an operation: where its arguments hold it, and what it writes, canonicalized */
interface StructureEntry {
  readonly location: string;
  readonly signature: string;
}

export type WriteStructure = readonly StructureEntry[];

/** The locations at which two write structures differ, in the order the structures list them */
export interface WriteStructureDifference {
  /** Writes only the second structure holds */
  readonly added: readonly string[];
  /** Writes only the first structure holds */
  readonly removed: readonly string[];
  /** Writes both hold that write to another model, another number of rows, or in another order */
  readonly changed: readonly string[];
}

const locationOf = (operation: NestedOperationInfo): string => {
  const { parent } = operation;
  const prefix = parent
    ? `${locationOf(parent.operation)}[${parent.element}].${parent.branch === undefined ? '' : `${parent.branch}.`}`
    : '';
  return `${prefix}${operation.fieldName}.${operation.operation}`;
};

const elementCountOf = (operation: NestedOperationInfo): number => {
  if (operation.operation === 'createMany') {
    return isRecord(operation.data) ? elementsOf(operation.data.data).length : 0;
  }
  return elementsOf(operation.data).length;
};

const nestedEntryOf =
  (branch: UpsertBranch | undefined) =>
  (operation: NestedOperationInfo): StructureEntry => ({
    location: branch === undefined ? locationOf(operation) : `${branch}.${locationOf(operation)}`,
    signature: JSON.stringify({
      model: operation.relatedModel,
      count: elementCountOf(operation),
      after: operation.precedingWrites.map((write) => write.operation),
      // The `true` / `false` of a to-one delete or disconnect, which decides whether it writes
      toOne: elementsOf(operation.data).filter((element) => typeof element === 'boolean'),
    }),
  });

/** The nested writes `args` hold, those of each branch of a top-level upsert apart */
const nestedEntriesOf = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  action: string,
  args: Record<string, unknown>,
): StructureEntry[] => {
  const branches: readonly (UpsertBranch | undefined)[] = action === 'upsert' ? ['create', 'update'] : [undefined];
  return branches.flatMap((branch) =>
    detectNestedOperations(
      schemaMetadata,
      modelName,
      args,
      branch === undefined ? { kind: 'discovery' } : { kind: 'discovery', topLevelUpsertBranch: branch },
    ).map(nestedEntryOf(branch)),
  );
};

export const writeStructureOf = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  action: string,
  args: unknown,
): WriteStructure => {
  if (!isRecord(args)) {
    return [];
  }
  const rows: StructureEntry[] =
    action === 'createMany' || action === 'createManyAndReturn'
      ? [{ location: 'data', signature: JSON.stringify({ count: elementsOf(args.data).length }) }]
      : [];
  return [...rows, ...nestedEntriesOf(schemaMetadata, modelName, action, args)];
};

const signaturesByLocation = (structure: WriteStructure): Map<string, string[]> => {
  const byLocation = new Map<string, string[]>();
  for (const { location, signature } of structure) {
    byLocation.set(location, [...(byLocation.get(location) ?? []), signature]);
  }
  return byLocation;
};

/** Where `final` differs from `received`, or `undefined` when both write the same relations and rows */
export const writeStructureDifference = (
  received: WriteStructure,
  final: WriteStructure,
): WriteStructureDifference | undefined => {
  const before = signaturesByLocation(received);
  const after = signaturesByLocation(final);
  const locations = [...new Set([...before.keys(), ...after.keys()])];
  const added = locations.filter((location) => !before.has(location));
  const removed = locations.filter((location) => !after.has(location));
  const changed = locations.filter(
    (location) =>
      before.has(location) &&
      after.has(location) &&
      before.get(location)?.join('\n') !== after.get(location)?.join('\n'),
  );
  return added.length + removed.length + changed.length === 0 ? undefined : { added, removed, changed };
};
