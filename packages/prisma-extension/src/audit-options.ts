/**
 * Audit options
 *
 * Validates the extension options once, at extension creation, and normalizes them into the
 * shape the audit pipeline consumes.
 */

import type {
  AuditContext,
  AuditContextProvider,
  ComposeConfig,
  PolicyConfig,
  ResolveConfig,
  WriteFn,
} from '@kuruwic/db-audit-core';
import { createAggregateConfig } from '@kuruwic/db-audit-core';
import { getNestedOperationConfig } from './config/helpers.js';
import { validateFieldConflicts } from './config/validation.js';
import type { GetOperationConfig } from './grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from './internal-types.js';
import type { SchemaMetadata } from './schema/types.js';
import type { AuditErrorObserver, PrismaAuditExtensionOptions, WriteFailurePolicy } from './types.js';
import { shouldAuditModel, uncapitalizeFirst } from './utils/extension-utils.js';
import { createSchemaMetadataFromDMMF } from './utils/schema-metadata.js';

export interface AuditOptions {
  readonly provider: AuditContextProvider;
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  /** Accessor of the audit-log model on the client (camelCase) */
  readonly auditLogModel: string;
  readonly policyConfig: PolicyConfig;
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly writer: WriteFn | undefined;
  readonly observer: AuditErrorObserver | undefined;
  readonly writeFailurePolicy: WriteFailurePolicy;
  readonly getNestedOperationConfig: GetOperationConfig;
  readonly modelTags: (modelName: string) => string[];
  /** Whether an operation on `modelName` is audited at all (audit-log model, loggability, sampling) */
  readonly shouldAudit: (modelName: string | undefined, context: AuditContext | undefined) => boolean;
}

/**
 * @throws {Error} If the aggregate mapping is invalid or the diffing and redaction settings conflict
 */
export const normalizeAuditOptions = (options: PrismaAuditExtensionOptions): AuditOptions => {
  const { provider, aggregateMapping, diffing, security, performance, hooks, contextEnricher, errorHandling } = options;

  const Prisma = options.Prisma as PrismaNamespace;
  const schemaMetadata = createSchemaMetadataFromDMMF(Prisma);
  const excludeFields = diffing?.excludeFields ?? [];
  const redact = security?.redact;
  const sampling = performance?.sampling ?? 1.0;
  const awaitWriteIf = performance?.awaitWriteIf;
  const samplingIf = performance?.samplingIf;

  const aggregateConfig = createAggregateConfig(aggregateMapping);
  validateFieldConflicts(excludeFields, redact, aggregateMapping);

  const modelTags = (modelName: string): string[] => aggregateConfig.getEntityConfig(modelName)?.tags ?? [];
  const auditLogModel = options.auditLogModel ? uncapitalizeFirst(options.auditLogModel) : 'auditLog';

  return {
    provider,
    Prisma,
    schemaMetadata,
    auditLogModel,
    policyConfig: {
      awaitWrite: performance?.awaitWrite ?? true,
      awaitWriteIf: awaitWriteIf && ((modelName, tags) => awaitWriteIf(modelName, [...tags])),
    },
    resolveConfig: {
      entity: aggregateConfig.getEntityConfig,
      rootEntity: aggregateConfig.getEntityConfigByType,
      actor: contextEnricher?.actor,
    },
    composeConfig: {
      entity: aggregateConfig.getEntityConfig,
      excludeFields,
      redact,
      serialization: options.serialization,
      relationFieldNames: (modelName) =>
        new Set(schemaMetadata.getRelationFields(modelName).map((field) => field.name)),
    },
    writer: hooks?.writer,
    observer: errorHandling?.observer,
    // An audit library must not break the caller's write by default.
    writeFailurePolicy: errorHandling?.writeFailurePolicy ?? 'log',
    getNestedOperationConfig: (modelName, operation) =>
      getNestedOperationConfig(modelName, operation, {
        getEntityConfig: aggregateConfig.getEntityConfig,
        globalNestedOperations: options.nestedOperations,
      }),
    modelTags,
    shouldAudit: (modelName, context) =>
      shouldAuditModel({
        modelName,
        context,
        auditLogModel,
        isLoggable: aggregateConfig.isLoggable,
        resolveSamplingRate: (model) => (samplingIf ? samplingIf(model, modelTags(model)) : sampling),
      }),
  };
};
