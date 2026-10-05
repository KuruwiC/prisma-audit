/**
 * Prisma Audit Extension
 *
 * The `$allOperations` hook: decides whether an intercepted operation is audited (its model, its
 * kind, then the write policy's sampling), selects the relations its nested writes touch, runs it
 * through the audited-operation pipeline on the library-owned runtime context, and returns the
 * result in the shape the caller requested. An operation of a batch transaction that runs as an
 * interactive one is first re-issued on that transaction's client, where the hook sees it again
 * as an operation of the transaction.
 *
 * @module extension
 * @see {@link createAuditLogExtension}
 * @see {@link PrismaAuditExtensionOptions}
 */

import { createFailureSink, policy } from '@kuruwic/db-audit-core';
import { createPrismaWriteExecutor, declaresBeforeUnavailableColumn } from './adapters/write-executor.js';
import { type AuditOptions, normalizeAuditOptions } from './audit-options.js';
import type { ExtensionParams, PrismaClientWithDynamicAccess } from './internal-types.js';
import { createBatchExecutor } from './pipeline/batch-executor.js';
import { createRecordProducer } from './pipeline/produce-records.js';
import { type AuditPipelineDependencies, runAuditedOperation } from './pipeline/run-audited-operation.js';
import { createSingleExecutor } from './pipeline/single-executor.js';
import { reissueOnBatchClient } from './runtime/batch-transaction.js';
import { currentScope, isProcessingAuditLog, withScope } from './runtime/scope.js';
import { createTransactionProxy } from './runtime/transaction-proxy.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import { type ClientShape, injectAuditedSelection, projectToRequestedShape } from './utils/audited-selection.js';
import { type ClientOmittedFields, readClientOmittedFields } from './utils/client-omit.js';
import { isAuditableAction } from './utils/extension-utils.js';

const createPipelineDependencies = (
  audit: AuditOptions,
  clientOmittedFields: ClientOmittedFields,
): AuditPipelineDependencies => {
  const { Prisma, schemaMetadata, shouldFetchBefore } = audit;
  const failureSink = createFailureSink(audit.errorHandling);

  return {
    provider: audit.provider,
    singleExecutor: createSingleExecutor({
      Prisma,
      schemaMetadata,
      shouldFetchBefore,
      clientOmittedFields,
      failureSink,
    }),
    batchExecutor: createBatchExecutor({ Prisma, schemaMetadata, clientOmittedFields, failureSink }),
    produceRecords: createRecordProducer({
      ...audit,
      // The fields the client omits are read, and recorded with their values masked.
      composeConfig: { ...audit.composeConfig, maskedFieldNames: clientOmittedFields.masked },
      failureSink,
    }),
    dispatchConfig: {
      writeExecutor: createPrismaWriteExecutor(Prisma.DbNull, {
        auditLogModel: audit.auditLogModel,
        storesBeforeUnavailable: declaresBeforeUnavailableColumn(Prisma.dmmf, audit.auditLogModel),
      }),
      writer: audit.writer,
      failureSink,
    },
    failureSink,
  };
};

interface ClientAudit {
  readonly baseClient: PrismaClientWithDynamicAccess;
  readonly deps: AuditPipelineDependencies;
  readonly reading: ClientShape;
}

/**
 * Creates the Prisma Client Extension for automatic audit logging
 *
 * @remarks
 * Internal extension factory, not exported from the package entry: `createAuditClient`
 * applies it via `prisma.$extends()` and returns the typed client.
 *
 * @throws {Error} If the aggregate mapping is invalid or the diffing and redaction settings conflict
 */
export const createAuditLogExtension = (options: PrismaAuditExtensionOptions) => {
  const audit = normalizeAuditOptions(options);

  // `awaitWriteIf` may return true for any model, so its presence counts as making an audit awaitable.
  const batchAuditMayBeAwaited = audit.policyConfig.awaitWrite || audit.policyConfig.awaitWriteIf !== undefined;

  const auditOperation = async (params: ExtensionParams, { baseClient, deps, reading }: ClientAudit) => {
    const { operation, model, args, query } = params;
    const auditContext = audit.provider.getContext();

    if (isProcessingAuditLog()) {
      return query(args);
    }
    if (!model || !auditContext || !audit.shouldAudit(model)) {
      return query(args);
    }
    if (!isAuditableAction(operation)) {
      return query(args);
    }
    const writePolicy = policy(model, audit.modelTags(model), audit.policyConfig);
    if (!writePolicy.sampled) {
      return query(args);
    }

    const injection = injectAuditedSelection(reading, model, operation, args);

    // Mark the re-entrancy guard on the library-owned runtime store; the app context
    // stays untouched so downstream code keeps the caller's actor and request metadata.
    const result = await withScope({ isProcessingAuditLog: true }, () =>
      runAuditedOperation(
        {
          operation: { model, action: operation, args: injection.args as Record<string, unknown>, query },
          auditContext,
          baseClient,
          atomic: writePolicy.atomic,
        },
        deps,
      ),
    );

    // The audit logs were built from the full result; the caller receives the shape it requested.
    return projectToRequestedShape(result, injection.injected);
  };

  const extensionDefinition = (baseClient: PrismaClientWithDynamicAccess) => {
    const clientOmittedFields = readClientOmittedFields(
      baseClient,
      audit.schemaMetadata,
      audit.Prisma.prismaVersion?.client,
    );
    const clientAudit: ClientAudit = {
      baseClient,
      deps: createPipelineDependencies(audit, clientOmittedFields),
      reading: {
        schemaMetadata: audit.schemaMetadata,
        queryOmitSupported: audit.queryOmitSupported,
        clientOmittedFields,
      },
    };
    const extendedClient = baseClient.$extends({
      name: 'prisma-audit',
      query: {
        async $allOperations(params: ExtensionParams) {
          const batchClient = currentScope()?.batchClient;
          return batchClient ? reissueOnBatchClient(batchClient, params) : auditOperation(params, clientAudit);
        },
      },
    });

    return createTransactionProxy(extendedClient as object, { provider: audit.provider, batchAuditMayBeAwaited });
  };

  return audit.Prisma.defineExtension(extensionDefinition);
};
