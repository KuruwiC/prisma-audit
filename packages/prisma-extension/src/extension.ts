/**
 * Prisma Audit Extension
 *
 * The `$allOperations` hook: decides whether an intercepted operation is audited (its kind, then
 * the audit gate, from the audit context, the audited models the operation's arguments write and
 * whether it is issued while the audit processes an operation, as a user callback issues it),
 * decides its write mode from those models and its write plan from the mode and the transaction
 * the operation's binding names, rejects it before it runs when the gate does, when it reached the
 * hook without the binding the client it was issued on gives it, or when it is atomic outside any
 * transaction the client owns, selects the relations its nested writes touch, runs it through the
 * audited-operation pipeline in that transaction, on the level open on the transaction's
 * connection when it starts, and returns the result in the shape the caller requested. Every
 * operation that writes rows of an audited model, audited, run unaudited or rejected, has an
 * outcome, settled once the transaction its binding names commits or rolls back, or, outside any,
 * once the operation returns or throws, except one the gate finds reentrant
 * (`AuditReentrantWriteError`) and one the client rejects below the audit before it reaches the
 * hook (`AuditParentWriteError`). The hook continues the caller's operation through `query`
 * unless it rejects it; the client proxy binds the operation, and for an atomic write opens the
 * interactive transaction, before the operation enters the extension chain.
 *
 * @module extension
 * @see {@link createAuditLogExtension}
 * @see {@link PrismaAuditExtensionOptions}
 */

import type { AuditContext, OperationOutcome, OutcomeConfig } from '@kuruwic/db-audit-core';
import {
  AuditAtomicityError,
  AuditContextMissingError,
  AuditReentrantWriteError,
  auditGate,
  createOperationOutcome,
  planFor,
  policy,
  settledIn,
} from '@kuruwic/db-audit-core';
import { createPrismaWriteExecutor, declaresBeforeUnavailableColumn } from './adapters/write-executor.js';
import { type AuditOptions, normalizeAuditOptions } from './audit-options.js';
import { AuditUnboundWriteError } from './errors.js';
import type { AuditAction } from './grammar/operations.js';
import type { ExtensionParams, PrismaBaseClient, PrismaHandle } from './internal-types.js';
import { createBatchExecutor } from './pipeline/batch-executor.js';
import type { OperationTransaction } from './pipeline/execution-scope.js';
import { createRecordProducer } from './pipeline/produce-records.js';
import { type AuditPipelineDependencies, runAuditedOperation } from './pipeline/run-audited-operation.js';
import { createSingleExecutor } from './pipeline/single-executor.js';
import type { RecipeConfig } from './runtime/operation-recipe.js';
import { operationBinding, withinAudit, withScope } from './runtime/scope.js';
import { createTransactionProxy } from './runtime/transaction-proxy.js';
import type { PrismaAuditExtensionOptions } from './types.js';
import { type ClientShape, injectAuditedSelection, projectToRequestedShape } from './utils/audited-selection.js';
import { isAuditableAction } from './utils/extension-utils.js';
import { getModelAccessor } from './utils/model-accessor.js';

const createPipelineDependencies = (audit: AuditOptions): AuditPipelineDependencies => {
  const { Prisma, schemaMetadata, shouldFetchBefore, auditedOmittedFields, auditedOmittedFieldsWithRowKey } = audit;

  return {
    singleExecutor: createSingleExecutor({
      Prisma,
      schemaMetadata,
      shouldFetchBefore,
      auditedOmittedFields,
      auditedOmittedFieldsWithRowKey,
      auditedModelsOf: audit.auditedModelsOf,
    }),
    batchExecutor: createBatchExecutor({ Prisma, schemaMetadata, auditedOmittedFieldsWithRowKey }),
    produceRecords: createRecordProducer({ ...audit, omittedFieldReads: { schemaMetadata, auditedOmittedFields } }),
    dispatchConfig: {
      writeExecutor: createPrismaWriteExecutor(Prisma.DbNull, {
        auditLogAccessor: audit.auditLogAccessor,
        storesBeforeUnavailable: declaresBeforeUnavailableColumn(schemaMetadata, audit.auditLogAccessor),
      }),
      writer: audit.writer,
    },
  };
};

/**
 * What the client proxy needs to make the client's operations into recipes, under each property
 * Prisma exposes a model delegate by (its camelCase accessor and its schema name), and to open the
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
    modelOfDelegateProperty: new Map(
      modelNames.flatMap((modelName) => [
        [getModelAccessor(modelName), modelName],
        [modelName, modelName],
      ]),
    ),
    relatedModel: (modelName, field) => relatedModels.get(modelName)?.get(field),
    isAtomicWrite: (modelName, action, args) =>
      audit.provider.getContext() !== undefined &&
      isAuditableAction(action) &&
      policy(audit.auditedModelsOf(modelName, args), policyConfig) === 'atomic',
  };
};

interface AuditedCall {
  readonly model: string;
  readonly operation: AuditAction;
  readonly args: ExtensionParams['args'];
  readonly query: ExtensionParams['query'];
}

/**
 * The observer, run with the re-entrancy guard raised like the other user callbacks: a write of an
 * audited model it makes through the audited client is rejected, without an outcome, so it cannot
 * recurse
 */
const guardedOutcomeConfig = ({ observer }: OutcomeConfig): OutcomeConfig =>
  observer ? { observer: (outcome) => withScope({ withinAudit: true }, () => observer(outcome)) } : {};

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
  const outcomeConfig = guardedOutcomeConfig(audit.outcomeConfig);

  /** `transaction` keeps the audit of the level the operation started on; the binding's follows the innermost level */
  const runAudited = async (
    { model, operation, args, query }: AuditedCall,
    auditedClient: PrismaHandle,
    auditedModels: readonly string[],
    auditContext: AuditContext,
    outcome: OperationOutcome,
    transaction: OperationTransaction | undefined,
  ) => {
    if (operationBinding() === undefined) {
      throw new AuditUnboundWriteError({ modelName: model, operation });
    }
    const mode = policy(auditedModels, audit.policyConfig);
    const plan = planFor(mode, transaction !== undefined);
    if (plan === 'reject') {
      throw new AuditAtomicityError({ modelName: model, operation });
    }

    const injection = injectAuditedSelection(shape, model, operation, args);

    // Mark the re-entrancy guard on the library-owned runtime store; the app context
    // stays untouched so downstream code keeps the caller's actor and request metadata.
    const result = await withScope({ withinAudit: true }, () =>
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
          auditedClient,
          mode,
          plan,
          transaction,
          outcome,
        },
        deps,
      ),
    );

    // The audit logs were built from the full result; the caller receives the shape it requested.
    return projectToRequestedShape(result, injection.injected);
  };

  const auditOperation = async (params: ExtensionParams, auditedClient: PrismaHandle) => {
    const { operation, model, args, query } = params;
    if (!model || !isAuditableAction(operation)) {
      return query(args);
    }

    const auditedModels = audit.auditedModelsOf(model, args);
    const gate = auditGate(
      { context: audit.provider.getContext(), auditedModels, withinAudit: withinAudit() },
      audit.gateConfig,
    );
    if (gate.kind === 'skip') {
      return query(args);
    }
    if (gate.kind === 'reentrant') {
      throw new AuditReentrantWriteError({ modelName: gate.modelName, operationModelName: model, operation });
    }
    const outcome = createOperationOutcome(
      { model, operation, ...(gate.kind === 'unaudited' ? { unaudited: gate.reason } : {}) },
      outcomeConfig,
    );
    const transaction = operationBinding()?.transaction;
    switch (gate.kind) {
      case 'reject':
        return settledIn(transaction?.audit, outcome, () => {
          throw new AuditContextMissingError({ modelName: gate.modelName, operationModelName: model, operation });
        });
      case 'unaudited':
        return settledIn(transaction?.audit, outcome, () => query(args));
      case 'audit': {
        const run = (operationTransaction: OperationTransaction | undefined) =>
          settledIn(operationTransaction?.audit, outcome, () =>
            runAudited(
              { model, operation, args, query },
              auditedClient,
              auditedModels,
              gate.context,
              outcome,
              operationTransaction,
            ),
          );
        return transaction
          ? transaction.runOperation((transactionAudit) =>
              run({ client: transaction.boundClient, audit: transactionAudit }),
            )
          : run(undefined);
      }
      default: {
        const exhaustiveCheck: never = gate;
        throw new Error(`[@prisma-audit] Unhandled audit gate: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };

  /**
   * Every operation that reaches the extension, audited or not, the audit's own queries included.
   * The failure of one bound to a transaction is recorded on the transaction: the database may
   * have aborted the transaction on it, even when the caller catches the error.
   */
  const interceptOperation = async (params: ExtensionParams, auditedClient: PrismaHandle) => {
    const transaction = operationBinding()?.transaction;
    try {
      return await auditOperation(params, auditedClient);
    } catch (error) {
      transaction?.noteStatementFailed();
      throw error;
    }
  };

  const extensionDefinition = (baseClient: PrismaBaseClient) => {
    const extendedClient = baseClient.$extends({
      name: 'prisma-audit',
      query: {
        $allOperations: (params: ExtensionParams) => interceptOperation(params, auditedClient),
      },
    });
    /** The client the audit and its user callbacks run on outside any transaction */
    const auditedClient: PrismaHandle = createTransactionProxy(extendedClient, {
      provider: audit.provider,
      recipeConfig,
    });
    return auditedClient;
  };

  return audit.Prisma.defineExtension(extensionDefinition);
};
