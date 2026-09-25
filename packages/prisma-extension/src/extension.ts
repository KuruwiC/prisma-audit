/**
 * Prisma Audit Extension
 *
 * The `$allOperations` hook: decides whether an intercepted operation is audited, selects the
 * relations its nested writes touch, runs it through the audited-operation pipeline on the
 * library-owned runtime context, and returns the result in the shape the caller requested.
 *
 * @module extension
 * @see {@link createAuditLogExtension}
 * @see {@link PrismaAuditExtensionOptions}
 */

import { createPrismaWriteExecutor } from './adapters/write-executor.js';
import { type AuditOptions, normalizeAuditOptions } from './audit-options.js';
import { createFailureSink } from './failure-sink.js';
import type { ExtensionParams, PrismaClientWithDynamicAccess } from './internal-types.js';
import { createTransactionProxy } from './lifecycle/transaction-proxy.js';
import { createBatchExecutor } from './pipeline/batch-executor.js';
import { createRecordProducer } from './pipeline/produce-records.js';
import { type AuditPipelineDependencies, runAuditedOperation } from './pipeline/run-audited-operation.js';
import { createSingleExecutor } from './pipeline/single-executor.js';
import { createAuditLogWriter } from './pipeline/write-audit-logs.js';
import { isProcessingAuditLog, withScope } from './runtime/scope.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import { injectNestedWriteSelection, isAuditableAction, projectToRequestedShape } from './utils/index.js';

const createPipelineDependencies = (audit: AuditOptions): AuditPipelineDependencies => {
  const { Prisma, schemaMetadata, getNestedOperationConfig } = audit;
  const failureSink = createFailureSink(audit);

  return {
    provider: audit.provider,
    policyConfig: audit.policyConfig,
    modelTags: audit.modelTags,
    singleExecutor: createSingleExecutor({ Prisma, schemaMetadata, getNestedOperationConfig, failureSink }),
    batchExecutor: createBatchExecutor({ Prisma, schemaMetadata }),
    produceRecords: createRecordProducer(audit),
    writeAuditLogs: createAuditLogWriter({
      auditLogModel: audit.auditLogModel,
      writeExecutor: createPrismaWriteExecutor(Prisma.DbNull),
      writer: audit.writer,
      failureSink,
    }),
    failureSink,
  };
};

/**
 * Creates the Prisma Client Extension for automatic audit logging
 *
 * @remarks
 * Internal extension factory, not exported from the package entry: `createAuditClient`
 * applies it via `prisma.$extends()` and returns the typed client.
 *
 * @returns Prisma Client Extension definition (use with `prisma.$extends()`)
 * @throws {Error} If configuration contains conflicts or peer dependency missing
 */
export const createAuditLogExtension = (options: PrismaAuditExtensionOptions) => {
  const audit = normalizeAuditOptions(options);
  const deps = createPipelineDependencies(audit);

  const extensionDefinition = (baseClient: PrismaClientWithDynamicAccess) => {
    const extendedClient = baseClient.$extends({
      name: 'prisma-audit',
      query: {
        $allModels: {
          async $allOperations(params: ExtensionParams) {
            const { operation, model, args, query } = params;
            const auditContext = audit.provider.getContext();

            if (isProcessingAuditLog()) {
              return query(args);
            }
            if (!model || !auditContext || !audit.shouldAudit(model, auditContext)) {
              return query(args);
            }
            if (!isAuditableAction(operation)) {
              return query(args);
            }

            const injection = injectNestedWriteSelection(audit.schemaMetadata, model, args);

            // Mark the re-entrancy guard on the library-owned runtime store; the app context
            // stays untouched so downstream code keeps the caller's actor and request metadata.
            const result = await withScope({ isProcessingAuditLog: true }, () =>
              runAuditedOperation(
                {
                  operation: { model, action: operation, args: injection.args as Record<string, unknown>, query },
                  auditContext,
                  baseClient,
                },
                deps,
              ),
            );

            // The audit logs were built from the full result; the caller receives the shape it requested.
            return projectToRequestedShape(result, injection.injected);
          },
        },
      },
    });

    return createTransactionProxy(extendedClient as object, audit.provider);
  };

  return audit.Prisma.defineExtension(extensionDefinition);
};
