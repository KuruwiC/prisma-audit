/**
 * Prisma Audit Extension
 *
 * The `$allOperations` hook: decides whether an intercepted operation is audited (its kind, then
 * the audit gate, from the audit context and the audited models the operation's arguments write),
 * decides its write mode from those models and its write plan from the mode and the transaction
 * the operation's binding names, rejects it before it runs when the gate does, when it reached the
 * hook without the binding the client it was issued on gives it, or when it is atomic outside any
 * transaction the client owns, selects the relations its nested writes touch, runs it through the
 * audited-operation pipeline in that transaction, and returns the result in the shape the caller
 * requested. The hook continues the caller's operation through `query` unless it rejects it; the
 * client proxy binds the operation, and for an atomic write opens the interactive transaction,
 * before the operation enters the extension chain.
 *
 * @module extension
 * @see {@link createAuditLogExtension}
 * @see {@link PrismaAuditExtensionOptions}
 */

import {
  AuditAtomicityError,
  AuditContextMissingError,
  auditGate,
  createFailureSink,
  planFor,
  policy,
} from '@kuruwic/db-audit-core';
import { createPrismaWriteExecutor, declaresBeforeUnavailableColumn } from './adapters/write-executor.js';
import { type AuditOptions, normalizeAuditOptions } from './audit-options.js';
import { AuditUnboundWriteError } from './errors.js';
import type { ExtensionParams, PrismaBaseClient } from './internal-types.js';
import { createBatchExecutor } from './pipeline/batch-executor.js';
import { createRecordProducer } from './pipeline/produce-records.js';
import { type AuditPipelineDependencies, runAuditedOperation } from './pipeline/run-audited-operation.js';
import { createSingleExecutor } from './pipeline/single-executor.js';
import type { RecipeConfig } from './runtime/operation-recipe.js';
import { isProcessingAuditLog, keepOperationFailure, operationBinding, withScope } from './runtime/scope.js';
import { createTransactionProxy } from './runtime/transaction-proxy.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import { type ClientShape, injectAuditedSelection, projectToRequestedShape } from './utils/audited-selection.js';
import { isAuditableAction } from './utils/extension-utils.js';
import { getModelAccessor } from './utils/model-accessor.js';

const createPipelineDependencies = (audit: AuditOptions): AuditPipelineDependencies => {
  const { Prisma, schemaMetadata, shouldFetchBefore, auditedOmittedFields, auditedOmittedFieldsWithRowKey } = audit;
  const { observer } = audit.failureSinkConfig;
  // The failures the pipeline detects itself are kept on the operation they were reported for, so
  // that an atomic one fails when some dropped its records. `dispatch` reports through a sink of
  // the observer alone, which logs a failure the caller cannot see when no observer is configured.
  const failureSink = createFailureSink({
    observer: async (context) => {
      keepOperationFailure(context);
      await observer?.(context);
    },
  });

  return {
    singleExecutor: createSingleExecutor({
      Prisma,
      schemaMetadata,
      shouldFetchBefore,
      auditedOmittedFields,
      auditedOmittedFieldsWithRowKey,
      failureSink,
    }),
    batchExecutor: createBatchExecutor({ Prisma, schemaMetadata, auditedOmittedFieldsWithRowKey, failureSink }),
    produceRecords: createRecordProducer({
      ...audit,
      omittedFieldReads: { schemaMetadata, auditedOmittedFields },
      failureSink,
    }),
    dispatchConfig: {
      writeExecutor: createPrismaWriteExecutor(Prisma.DbNull, {
        auditLogAccessor: audit.auditLogAccessor,
        storesBeforeUnavailable: declaresBeforeUnavailableColumn(schemaMetadata, audit.auditLogAccessor),
      }),
      writer: audit.writer,
      failureSink: createFailureSink(audit.failureSinkConfig),
    },
    failureSink,
  };
};

/**
 * What the client proxy needs to make the client's operations into recipes and to open the
 * interactive transaction of an atomic write. Whether one is opened is decided from the arguments
 * the call was made with; the hook decides whether the operation is audited, its write mode, or
 * whether it is rejected, from the arguments that reach it.
 */
const recipeConfigOf = (audit: AuditOptions): RecipeConfig => {
  const { policyConfig, schemaMetadata } = audit;
  const modelNames = schemaMetadata.getModelNames();
  const relatedModels = new Map(
    modelNames.map((modelName) => [
      modelName,
      new Map(schemaMetadata.getRelationFields(modelName).map((field) => [field.name, field.relatedModel])),
    ]),
  );
  return {
    modelOfAccessor: new Map(modelNames.map((modelName) => [getModelAccessor(modelName), modelName])),
    relatedModel: (modelName, field) => relatedModels.get(modelName)?.get(field),
    isAtomicWrite: (modelName, action, args) =>
      audit.provider.getContext() !== undefined &&
      isAuditableAction(action) &&
      policy(audit.auditedModelsOf(modelName, args), policyConfig) === 'atomic',
  };
};

/**
 * Creates the Prisma Client Extension for automatic audit logging
 *
 * @remarks
 * Internal extension factory, not exported from the package entry: `createAuditClient`
 * applies it via `prisma.$extends()` and returns the typed client.
 *
 * @throws {Error} If the options are invalid (see `normalizeAuditOptions`)
 */
export const createAuditLogExtension = (options: PrismaAuditExtensionOptions) => {
  const audit = normalizeAuditOptions(options);

  const recipeConfig = recipeConfigOf(audit);
  const deps = createPipelineDependencies(audit);
  const shape: ClientShape = { schemaMetadata: audit.schemaMetadata, queryOmitSupported: audit.queryOmitSupported };

  const auditOperation = async (params: ExtensionParams, baseClient: PrismaBaseClient) => {
    const { operation, model, args, query } = params;
    if (isProcessingAuditLog() || !model || !isAuditableAction(operation)) {
      return query(args);
    }

    const auditedModels = audit.auditedModelsOf(model, args);
    const gate = auditGate(audit.provider.getContext(), auditedModels, audit.gateConfig);
    if (gate.kind === 'reject') {
      throw new AuditContextMissingError({ modelName: gate.modelName, operationModelName: model, operation });
    }
    if (gate.kind === 'skip') {
      return query(args);
    }
    const binding = operationBinding();
    if (binding === undefined) {
      throw new AuditUnboundWriteError({ modelName: model, operation });
    }
    const mode = policy(auditedModels, audit.policyConfig);
    const plan = planFor(mode, binding.transaction !== undefined);
    if (plan === 'reject') {
      throw new AuditAtomicityError({ modelName: model, operation });
    }
    const auditContext = gate.context;

    const injection = injectAuditedSelection(shape, model, operation, args);

    // Mark the re-entrancy guard on the library-owned runtime store; the app context
    // stays untouched so downstream code keeps the caller's actor and request metadata.
    const result = await withScope({ isProcessingAuditLog: true }, () =>
      runAuditedOperation(
        {
          operation: {
            model,
            action: operation,
            args: injection.args as Record<string, unknown>,
            query,
            widened: injection.widened,
          },
          auditContext,
          baseClient,
          mode,
          plan,
          transaction: binding.transaction,
        },
        deps,
      ),
    );

    // The audit logs were built from the full result; the caller receives the shape it requested.
    return projectToRequestedShape(result, injection.injected);
  };

  const extensionDefinition = (baseClient: PrismaBaseClient) => {
    const extendedClient = baseClient.$extends({
      name: 'prisma-audit',
      query: {
        $allOperations: (params: ExtensionParams) => auditOperation(params, baseClient),
      },
    });

    return createTransactionProxy(extendedClient, { provider: audit.provider, recipeConfig });
  };

  return audit.Prisma.defineExtension(extensionDefinition);
};
