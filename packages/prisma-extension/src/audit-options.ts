/**
 * Audit options
 *
 * Validates the extension options once, at extension creation, and normalizes them into the
 * shape the audit pipeline consumes.
 */

import type {
  AuditContextProvider,
  ComposeConfig,
  ErrorHandlingConfig,
  PolicyConfig,
  ResolveConfig,
  WriteFn,
} from '@kuruwic/db-audit-core';
import { createEntityConfigLookup } from '@kuruwic/db-audit-core';
import { resolveFetchBefore } from './config/helpers.js';
import { validateFieldConflicts } from './config/validation.js';
import type { ShouldFetchBefore } from './grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from './internal-types.js';
import type { SchemaMetadata } from './schema/types.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import { shouldAuditModel } from './utils/extension-utils.js';
import { getModelAccessor } from './utils/model-accessor.js';
import { supportsQueryOmit } from './utils/prisma-version.js';
import { createSchemaMetadataFromDMMF } from './utils/schema-metadata.js';

export interface AuditOptions {
  readonly provider: AuditContextProvider;
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  /** Whether the client accepts a query `omit`, used to read a caller `select` in the default shape */
  readonly queryOmitSupported: boolean;
  /** Accessor of the audit-log model on the client (camelCase) */
  readonly auditLogModel: string;
  readonly policyConfig: PolicyConfig;
  /** Whether the client proxy opens an interactive transaction for an operation whose audit is awaited */
  readonly openImplicitTransaction: boolean;
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly writer: WriteFn | undefined;
  readonly errorHandling: ErrorHandlingConfig;
  readonly shouldFetchBefore: ShouldFetchBefore;
  readonly modelTags: (modelName: string) => string[];
  /**
   * Whether operations on `modelName` are audited at all: it is not the audit-log model and is
   * loggable. Sampling is decided by `policyConfig`.
   */
  readonly shouldAudit: (modelName: string) => boolean;
}

/** The relation counts Prisma returns with a row when a query includes or selects `_count` */
const RELATION_COUNT_FIELD = '_count';

/**
 * @throws {Error} If the aggregate mapping is invalid or the diffing and redaction settings conflict
 */
export const normalizeAuditOptions = (options: PrismaAuditExtensionOptions): AuditOptions => {
  const { provider, aggregateMapping, diffing, security, performance, hooks, contextEnricher, errorHandling } = options;

  const Prisma = options.Prisma as PrismaNamespace;
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  const excludeFields = diffing?.excludeFields ?? [];
  const redact = security?.redact;
  const awaitWriteIf = performance?.awaitWriteIf;
  const samplingIf = performance?.samplingIf;

  const entityConfigs = createEntityConfigLookup(aggregateMapping);
  validateFieldConflicts(excludeFields, redact, aggregateMapping);

  const modelTags = (modelName: string): string[] => entityConfigs.byModel(modelName)?.tags ?? [];
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
  const auditLogModel = options.auditLogModel ? getModelAccessor(options.auditLogModel) : 'auditLog';

  return {
    provider,
    Prisma,
    schemaMetadata,
    queryOmitSupported: supportsQueryOmit(Prisma.prismaVersion?.client),
    auditLogModel,
    openImplicitTransaction: performance?.openImplicitTransaction ?? false,
    policyConfig: {
      awaitWrite: performance?.awaitWrite ?? true,
      awaitWriteIf: awaitWriteIf && ((modelName, tags) => awaitWriteIf(modelName, [...tags])),
      sampling: performance?.sampling ?? 1.0,
      samplingIf: samplingIf && ((modelName, tags) => samplingIf(modelName, [...tags])),
    },
    resolveConfig: {
      entity: entityConfigs.byModel,
      rootEntity: entityConfigs.byCategoryAndType,
      actor: contextEnricher?.actor,
    },
    composeConfig: {
      entity: entityConfigs.byModel,
      excludeFields,
      redact,
      serialization: options.serialization,
      relationFieldNames,
    },
    writer: hooks?.writer,
    errorHandling: errorHandling ?? {},
    shouldFetchBefore: (modelName, operation) => resolveFetchBefore(modelName, operation, options.fetchBefore),
    modelTags,
    shouldAudit: (modelName) => shouldAuditModel({ modelName, auditLogModel, isLoggable: entityConfigs.isLoggable }),
  };
};
