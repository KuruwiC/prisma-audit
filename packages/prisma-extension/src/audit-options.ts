/**
 * Audit options
 *
 * Validates the extension options once, at extension creation, and normalizes them into the
 * shape the audit pipeline consumes.
 */

import type {
  AuditContextProvider,
  ComposeConfig,
  FailureSinkConfig,
  PolicyConfig,
  ResolveConfig,
  WriteFn,
} from '@kuruwic/db-audit-core';
import { createEntityConfigLookup } from '@kuruwic/db-audit-core';
import { resolveFetchBefore } from './config/helpers.js';
import {
  validateAuditOmittedFields,
  validateFieldConflicts,
  validateImplicitTransaction,
} from './config/validation.js';
import type { ShouldFetchBefore } from './grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from './internal-types.js';
import { loadSchemaMetadata } from './schema/schema-metadata.js';
import type { SchemaMetadata } from './schema/types.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import {
  type AuditedOmittedFields,
  createAuditedOmittedFields,
  withRowKeyFields,
} from './utils/audited-omitted-fields.js';
import { shouldAuditModel } from './utils/extension-utils.js';
import { getModelAccessor } from './utils/model-accessor.js';
import { supportsQueryOmit } from './utils/prisma-version.js';

export interface AuditOptions {
  readonly provider: AuditContextProvider;
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  /** Whether the client accepts a query `omit`, used to read a caller `select` in the default shape */
  readonly queryOmitSupported: boolean;
  /** The fields a client-level `omit` hides that the audit reads, from the entities' `auditOmittedFields` */
  readonly auditedOmittedFields: AuditedOmittedFields;
  /**
   * `auditedOmittedFields` with each model's row key on a client that takes a query omit: the fields
   * the audit's batch reads and the top-level read before the write name, so the rows they read carry
   * their key whatever a client omit hides
   */
  readonly auditedOmittedFieldsWithRowKey: AuditedOmittedFields;
  /** Accessor of the audit-log model on the client (camelCase) */
  readonly auditLogAccessor: string;
  readonly policyConfig: PolicyConfig;
  /** Whether the client proxy opens an interactive transaction for an operation whose audit is awaited */
  readonly implicitTransaction: boolean;
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly writer: WriteFn | undefined;
  readonly failureSinkConfig: FailureSinkConfig;
  readonly shouldFetchBefore: ShouldFetchBefore;
  /**
   * Whether operations on `modelName` are audited at all: it is not the audit-log model and is
   * loggable. Sampling is decided by `policyConfig`.
   */
  readonly shouldAudit: (modelName: string) => boolean;
}

/** The relation counts Prisma returns with a row when a query includes or selects `_count` */
const RELATION_COUNT_FIELD = '_count';

/**
 * @throws {Error} If the `schema` option is missing or of another format version, the entity
 *   map is invalid, the diffing and redaction settings conflict, an entity's
 *   `auditOmittedFields` names a field the audit cannot read, or `write.implicitTransaction` is set
 *   with `write.awaited: false`
 */
export const normalizeAuditOptions = (options: PrismaAuditExtensionOptions): AuditOptions => {
  const { contextProvider, entities, diffing, security, write, actorContext, errorObserver } = options;

  const schemaMetadata = loadSchemaMetadata(options.schema);
  const Prisma = options.Prisma as PrismaNamespace;
  const excludeFields = diffing?.excludeFields ?? [];
  const redact = security?.redact;

  const entityConfigs = createEntityConfigLookup(entities);
  validateFieldConflicts(excludeFields, redact, entities);
  validateImplicitTransaction(write);
  const queryOmitSupported = supportsQueryOmit(Prisma.prismaVersion?.client);
  validateAuditOmittedFields(entities, schemaMetadata, schemaMetadata.getModelNames(), queryOmitSupported);

  const relationFieldNamesByModel = new Map<string, ReadonlySet<string>>();
  const relationFieldNames = (modelName: string): ReadonlySet<string> => {
    let names = relationFieldNamesByModel.get(modelName);
    if (names === undefined) {
      names = new Set([
        ...schemaMetadata.getRelationFields(modelName).map((field) => field.name),
        RELATION_COUNT_FIELD,
      ]);
      relationFieldNamesByModel.set(modelName, names);
    }
    return names;
  };
  const auditLogAccessor = write?.model ? getModelAccessor(write.model) : 'auditLog';
  const auditedOmittedFields = createAuditedOmittedFields(entityConfigs.byModel, excludeFields);

  return {
    provider: contextProvider,
    Prisma,
    schemaMetadata,
    queryOmitSupported,
    auditedOmittedFields,
    auditedOmittedFieldsWithRowKey: withRowKeyFields(auditedOmittedFields, schemaMetadata, queryOmitSupported),
    auditLogAccessor,
    implicitTransaction: write?.implicitTransaction ?? false,
    policyConfig: {
      awaited: write?.awaited ?? true,
      samplingRate: options.samplingRate ?? 1,
    },
    resolveConfig: {
      entity: entityConfigs.byModel,
      rootEntity: entityConfigs.byCategoryAndType,
      actorContext,
    },
    composeConfig: {
      entity: entityConfigs.byModel,
      excludeFields,
      redact,
      serialization: options.serialization,
      relationFieldNames,
    },
    writer: write?.writer,
    failureSinkConfig: { observer: errorObserver, writeOnError: write?.onError },
    shouldFetchBefore: (modelName, operation) => resolveFetchBefore(modelName, operation, options.fetchBefore),
    shouldAudit: (modelName) => shouldAuditModel({ modelName, auditLogAccessor, isLoggable: entityConfigs.isLoggable }),
  };
};
