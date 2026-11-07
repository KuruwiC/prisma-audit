/**
 * Audit options
 *
 * Validates the extension options once, at extension creation, and normalizes them into the
 * shape the audit pipeline consumes.
 */

import type {
  AuditContextProvider,
  AuditGateConfig,
  ComposeConfig,
  OutcomeConfig,
  PolicyConfig,
  ResolveConfig,
  WriteFn,
} from '@kuruwic/db-audit-core';
import { createEntityConfigLookup } from '@kuruwic/db-audit-core';
import { createShouldFetchBefore } from './config/helpers.js';
import {
  type AuditRowDestination,
  validateAuditRowDestinations,
  validateFieldConflicts,
  validateRecordOmittedFields,
} from './config/validation.js';
import type { ShouldFetchBefore } from './grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from './internal-types.js';
import { loadSchemaMetadata } from './schema/schema-metadata.js';
import type { SchemaMetadata } from './schema/types.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import { auditedModelsWrittenBy } from './utils/audited-models.js';
import {
  type AuditedOmittedFields,
  createAuditedOmittedFields,
  withRowKeyFields,
} from './utils/audited-omitted-fields.js';
import { getModelAccessor } from './utils/model-accessor.js';
import { writesModelsOf } from './utils/normalized-writer.js';
import { supportsQueryOmit } from './utils/prisma-version.js';

export interface AuditOptions {
  readonly provider: AuditContextProvider;
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  /** Whether the client accepts a query `omit`, used to read a caller `select` in the default shape */
  readonly queryOmitSupported: boolean;
  /** The fields a client-level `omit` hides that the audit reads, from the entities' `recordOmittedFields` */
  readonly auditedOmittedFields: AuditedOmittedFields;
  /**
   * `auditedOmittedFields` with each model's row key on a client that takes a query omit: the fields
   * the audit's batch reads and the top-level read before the write name, so the rows they read carry
   * their key whatever a client omit hides
   */
  readonly auditedOmittedFieldsWithRowKey: AuditedOmittedFields;
  /** Accessor of the audit-log model on the client (camelCase) */
  readonly auditLogAccessor: string;
  /** Whether a write runs without an audit context, from `requireContext` */
  readonly gateConfig: AuditGateConfig;
  /** The write mode of each audited model: its entity's `writeMode`, else `write.mode` */
  readonly policyConfig: PolicyConfig;
  readonly resolveConfig: ResolveConfig;
  readonly composeConfig: ComposeConfig;
  readonly writer: WriteFn | undefined;
  readonly outcomeConfig: OutcomeConfig;
  readonly shouldFetchBefore: ShouldFetchBefore;
  /**
   * The audited models an operation on `modelName` with `args` writes rows of, its nested writes
   * included: the input of the audit gate and the write policy. A model is audited when it is in
   * the entity map, which lists none of the models the audit rows are written to.
   */
  readonly auditedModelsOf: (modelName: string, args: unknown) => string[];
}

const DEFAULT_AUDIT_LOG_MODEL = 'AuditLog';

/** The relation counts Prisma returns with a row when a query includes or selects `_count` */
const RELATION_COUNT_FIELD = '_count';

/**
 * @throws {Error} If the `schema` option is missing or of another format version, the entity
 *   map is invalid or lists a model the audit rows are written to (the `write.model` model, the
 *   default one unless a `write.writer` replaces the default write, or one a normalized writer
 *   declares), `diffExcludeFields` and `redactFields` name the same field, or an entity's
 *   `recordOmittedFields` names a field the audit cannot read
 */
export const normalizeAuditOptions = (options: PrismaAuditExtensionOptions): AuditOptions => {
  const { contextProvider, entities, write, actorContext, observer } = options;

  const schemaMetadata = loadSchemaMetadata(options.schema);
  const Prisma = options.Prisma as PrismaNamespace;
  const diffExcludeFields = options.diffExcludeFields ?? [];
  const redactFields = options.redactFields ?? [];

  const entityConfigs = createEntityConfigLookup(entities);
  const auditLogModel = write?.model ?? DEFAULT_AUDIT_LOG_MODEL;
  const modelDestination: AuditRowDestination = { modelName: auditLogModel, source: 'write.model' };
  // A custom writer declares where it writes only through `writesModels`, so the default model is
  // not checked for it; the gate's rejection of its writes to an audited model is the backstop.
  const auditRowDestinations: AuditRowDestination[] = [
    ...(write?.model !== undefined || write?.writer === undefined ? [modelDestination] : []),
    ...writesModelsOf(write?.writer).map((modelName): AuditRowDestination => ({ modelName, source: 'write.writer' })),
  ];
  validateAuditRowDestinations(auditRowDestinations, entityConfigs.isLoggable);
  validateFieldConflicts(diffExcludeFields, redactFields, entities);
  const queryOmitSupported = supportsQueryOmit(Prisma.prismaVersion?.client);
  validateRecordOmittedFields(entities, schemaMetadata, schemaMetadata.getModelNames(), queryOmitSupported);

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
  const auditLogAccessor = getModelAccessor(auditLogModel);
  const auditedOmittedFields = createAuditedOmittedFields(entityConfigs.byModel, diffExcludeFields);

  return {
    provider: contextProvider,
    Prisma,
    schemaMetadata,
    queryOmitSupported,
    auditedOmittedFields,
    auditedOmittedFieldsWithRowKey: withRowKeyFields(auditedOmittedFields, schemaMetadata, queryOmitSupported),
    auditLogAccessor,
    gateConfig: { requireContext: options.requireContext },
    policyConfig: { mode: write?.mode, entity: entityConfigs.byModel },
    resolveConfig: {
      entity: entityConfigs.byModel,
      rootEntity: entityConfigs.byCategoryAndType,
      actorContext,
    },
    composeConfig: {
      entity: entityConfigs.byModel,
      diffExcludeFields,
      redactFields,
      serializers: options.serializers,
      relationFieldNames,
    },
    writer: write?.writer,
    outcomeConfig: { observer },
    shouldFetchBefore: createShouldFetchBefore(entityConfigs.byModel, options.fetchBefore),
    auditedModelsOf: (modelName, args) =>
      auditedModelsWrittenBy(schemaMetadata, entityConfigs.isLoggable, modelName, args),
  };
};
