/**
 * Extension checkpoints
 *
 * Prisma runs a query extension applied to an audited client (`createAuditClient(prisma).$extends(extension)`)
 * between the audit and the database, so the audit records a model write from arguments such an
 * extension may still change. The client proxy therefore places a checkpoint, a query extension of
 * its own, innermost on the client each such extension derives; a client's checkpoints run in the
 * order the extensions were applied, the innermost right before the database.
 *
 * The audit continues a model write with its write structure (`grammar/write-structure.ts`) in
 * scope. Each checkpoint the write reaches reads the arguments as Prisma sends them
 * (`utils/arguments-as-sent.ts`), compares their structure with the audit's, and goes on with
 * exactly those arguments. The innermost checkpoint lets the write reach the database once (again
 * only after a failed attempt), and the audit rejects a write that settles without having reached
 * it: an extension applied after the audit may change the values a write writes, and must continue
 * it through `query`. Reads and raw queries pass unchecked.
 *
 * @module runtime/extension-checkpoint
 */

import { type AuditContinuationViolation, AuditExtensionContinuationError, AuditUnboundWriteError } from '../errors.js';
import { type WriteStructure, writeStructureDifference, writeStructureOf } from '../grammar/write-structure.js';
import type { ExtensionParams } from '../internal-types.js';
import type { SchemaMetadata } from '../schema/types.js';
import { argumentsAsSent } from '../utils/arguments-as-sent.js';
import { isAuditableAction } from '../utils/extension-utils.js';
import { currentScope, withScope } from './scope.js';

export interface ExtensionCheckpoint {
  readonly extensionName: string | undefined;
  /** The checkpoint innermost on the client the extension was applied to; undefined when it has none */
  readonly previous: ExtensionCheckpoint | undefined;
}

type ContinuationProgress = 'unreached' | 'running' | 'failed' | 'written';

interface WriteProgress {
  progress: ContinuationProgress;
}

export interface WriteContinuation extends WriteProgress {
  readonly structure: WriteStructure;
  readonly innermost: ExtensionCheckpoint;
  /**
   * The last checkpoint the write went past toward the database, or, once a failure goes back
   * through a checkpoint, the one before it: the extension right after that holds the write
   */
  lastReached: ExtensionCheckpoint | undefined;
  settled: boolean;
}

type Query = ExtensionParams['query'];

export interface CheckpointExtension {
  readonly name: string;
  readonly query: { readonly $allOperations: (params: ExtensionParams) => Promise<unknown> };
}

export interface ContinuedWrite {
  readonly model: string;
  readonly operation: string;
  readonly query: Query;
}

export interface CheckedWrite {
  readonly query: Query;
  /** True once a call of `query` sent the write to the database, and from then on; a failed attempt alone does not count */
  readonly reachedDatabase: () => boolean;
}

export interface ExtensionCheckpoints {
  /**
   * The checkpoint after the extension named `extensionName`, applied to a client whose innermost
   * checkpoint is `previous`, with the extension that places it on the client that one derives
   */
  readonly checkpointAfter: (
    extensionName: string | undefined,
    previous: ExtensionCheckpoint | undefined,
  ) => { readonly checkpoint: ExtensionCheckpoint; readonly extension: CheckpointExtension };
  /**
   * The `query` the audit continues `write` with, checked by the checkpoints of the client the
   * write was issued on, whose innermost checkpoint is `innermost`, and whether the write reached
   * the database; a client with none continues `write.query` unchecked and tracks the same fact
   */
  readonly checkedQuery: (write: ContinuedWrite, innermost: ExtensionCheckpoint | undefined) => CheckedWrite;
}

const CHECKPOINT_EXTENSION_NAME = 'prisma-audit-checkpoint';

/** How a write reaching a checkpoint with arguments of `structure` departs from `continuation`; undefined when it does not */
const violationAt = (
  continuation: WriteContinuation,
  structure: WriteStructure,
): AuditContinuationViolation | undefined => {
  if (continuation.settled) {
    return { kind: 'continued-after-settling' };
  }
  if (continuation.progress === 'running' || continuation.progress === 'written') {
    return { kind: 'continued-twice' };
  }
  const difference = writeStructureDifference(continuation.structure, structure);
  return difference === undefined ? undefined : { kind: 'structure', ...difference };
};

/** The checkpoint following the extension that holds a write which did not reach the database */
const holderOf = ({ innermost, lastReached }: WriteContinuation): ExtensionCheckpoint => {
  let checkpoint = innermost;
  while (checkpoint !== lastReached && checkpoint.previous !== lastReached && checkpoint.previous !== undefined) {
    checkpoint = checkpoint.previous;
  }
  return checkpoint;
};

const rejection = (
  extensionName: string | undefined,
  { model, operation }: Pick<ContinuedWrite, 'model' | 'operation'>,
  violation: AuditContinuationViolation,
) => new AuditExtensionContinuationError({ extensionName, modelName: model, operation, violation });

const runWrite = async (attempt: WriteProgress, run: () => Promise<unknown>): Promise<unknown> => {
  attempt.progress = 'running';
  try {
    const result = await run();
    attempt.progress = 'written';
    return result;
  } catch (error) {
    attempt.progress = 'failed';
    throw error;
  }
};

const handOn = async (
  continuation: WriteContinuation,
  checkpoint: ExtensionCheckpoint,
  run: () => Promise<unknown>,
): Promise<unknown> => {
  try {
    return await run();
  } catch (error) {
    continuation.lastReached = checkpoint.previous;
    throw error;
  }
};

export const createExtensionCheckpoints = (schemaMetadata: SchemaMetadata): ExtensionCheckpoints => {
  const reached =
    (checkpoint: ExtensionCheckpoint) =>
    async ({ model, operation, args, query }: ExtensionParams): Promise<unknown> => {
      if (!model || !isAuditableAction(operation)) {
        return query(args);
      }
      const continuation = currentScope()?.continuation;
      if (continuation === undefined) {
        throw new AuditUnboundWriteError({ modelName: model, operation });
      }
      const sent = argumentsAsSent(args);
      const violation = violationAt(continuation, writeStructureOf(schemaMetadata, model, operation, sent));
      if (violation !== undefined) {
        throw rejection(checkpoint.extensionName, { model, operation }, violation);
      }
      continuation.lastReached = checkpoint;
      return checkpoint === continuation.innermost
        ? runWrite(continuation, () => query(sent))
        : handOn(continuation, checkpoint, () => query(sent));
    };

  const checkpointAfter: ExtensionCheckpoints['checkpointAfter'] = (extensionName, previous) => {
    const checkpoint: ExtensionCheckpoint = { extensionName, previous };
    return {
      checkpoint,
      extension: { name: CHECKPOINT_EXTENSION_NAME, query: { $allOperations: reached(checkpoint) } },
    };
  };

  const checkedQuery: ExtensionCheckpoints['checkedQuery'] = (write, innermost) => {
    const attempts: WriteProgress[] = [];
    const reachedDatabase = () => attempts.some(({ progress }) => progress === 'running' || progress === 'written');
    if (innermost === undefined) {
      return {
        query: (args) => {
          const attempt: WriteProgress = { progress: 'unreached' };
          attempts.push(attempt);
          return runWrite(attempt, () => write.query(args));
        },
        reachedDatabase,
      };
    }
    const query: Query = async (args) => {
      const sent = argumentsAsSent(args);
      const continuation: WriteContinuation = {
        structure: writeStructureOf(schemaMetadata, write.model, write.operation, sent),
        innermost,
        lastReached: undefined,
        progress: 'unreached',
        settled: false,
      };
      attempts.push(continuation);
      let result: unknown;
      try {
        // Awaited in the scope, so that Prisma's operation, which starts once awaited, starts in it
        result = await withScope({ continuation }, async () => await write.query(sent));
      } finally {
        continuation.settled = true;
      }
      if (continuation.progress !== 'written') {
        throw rejection(holderOf(continuation).extensionName, write, { kind: 'not-continued' });
      }
      return result;
    };
    return { query, reachedDatabase };
  };

  return { checkpointAfter, checkedQuery };
};
