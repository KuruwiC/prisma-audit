/**
 * Operation recipes
 *
 * With `write.implicitTransaction`, a call on a model delegate or a raw-query method of the audited
 * client, or of a client derived from it, does not reach Prisma when it is made. It returns a
 * recipe: a lazy thenable holding the client the call was made on, the call, and the fluent
 * relation calls chained on it. Awaiting the recipe replays the calls on that client, inside an
 * interactive transaction of the client when the call is a write whose audit is awaited, so the
 * call enters the client's extension chain once, already inside the transaction. Inside a callback
 * of your interactive `$transaction` too: the call is not made on the transaction's client, so it
 * runs in a transaction of its own, together with its audit. A batch `$transaction([...])`
 * replays the client's recipes in one transaction. A recipe is not a PrismaPromise: Prisma's own
 * `$transaction` rejects it.
 */

import type { WritePolicy } from '@kuruwic/db-audit-core';
import { isProcessingAuditLog, type WritePolicyDecision, withScope } from './scope.js';

/** The model actions Prisma's delegates expose as lazy operations */
const MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'aggregate',
  'groupBy',
  'count',
  'findRaw',
  'aggregateRaw',
]);

/** The actions whose result a fluent relation call can follow */
const FLUENT_ACTIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'create',
  'update',
  'upsert',
  'delete',
]);

/** The client methods that return lazy operations without a model */
const RAW_METHODS: ReadonlySet<string> = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$queryRawTyped',
  '$executeRaw',
  '$executeRawUnsafe',
  '$runCommandRaw',
]);

export interface RecipeConfig {
  /** The model each model delegate property of the client names */
  readonly modelOfAccessor: ReadonlyMap<string, string>;
  /** The model a relation field of `model` leads to */
  readonly relatedModel: (model: string, field: string) => string | undefined;
  /**
   * The write policy of a call of `action` on `model` with `args`, the arguments the call was made
   * with, decided now, sampling included; undefined when the call is not audited
   */
  readonly decideWritePolicy: (model: string, action: string, args: unknown) => WritePolicy | undefined;
}

interface RecipeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface Recipe {
  /** The audited client the call was made on, whose `$transaction` the recipe runs in */
  readonly receiver: object;
  /** The client behind `receiver`, the one Prisma runs the call on */
  readonly target: object;
  /** The model delegate property the call was made on; absent for a raw-query method */
  readonly accessor: string | undefined;
  readonly model: string | undefined;
  readonly call: RecipeCall;
  readonly relationCalls: readonly RecipeCall[];
  /** The model a further fluent relation call starts from; absent when none can follow */
  readonly fluentModel: string | undefined;
  /** Pending until the recipe is first awaited, which starts it, or taken by a batch, which runs it */
  state: RecipeState;
}

type RecipeState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'started'; readonly result: Promise<unknown> }
  | { readonly kind: 'taken-by-batch' };

/** What `Object.prototype.toString` names a recipe; not `PrismaPromise`, which Prisma's own batch accepts */
const RECIPE_TAG = 'PrismaAuditOperation';

const recipes = new WeakMap<object, Recipe>();

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' || typeof value === 'function') && value !== null;

const invoke = (owner: unknown, call: RecipeCall): unknown => {
  const method: unknown = isObject(owner) ? Reflect.get(owner, call.method) : undefined;
  if (typeof method !== 'function') {
    throw new Error(`Client method "${call.method}" not found`);
  }
  return Reflect.apply(method, owner, call.args);
};

/** Makes the recipe's calls on `client`, and returns Prisma's operation, not yet started */
const replay = (recipe: Recipe, client: object): unknown => {
  const owner = recipe.accessor === undefined ? client : Reflect.get(client, recipe.accessor);
  let operation = invoke(owner, recipe.call);
  for (const relationCall of recipe.relationCalls) {
    operation = invoke(operation, relationCall);
  }
  return operation;
};

const runInTransaction = (receiver: object, run: (tx: object) => Promise<unknown>): Promise<unknown> =>
  Promise.resolve(invoke(receiver, { method: '$transaction', args: [run] }));

const decisionOf = (recipe: Recipe, config: RecipeConfig): WritePolicyDecision | undefined => {
  if (recipe.model === undefined || isProcessingAuditLog()) {
    return undefined;
  }
  const policy = config.decideWritePolicy(recipe.model, recipe.call.method, recipe.call.args[0]);
  return policy && { model: recipe.model, action: recipe.call.method, policy };
};

/**
 * `operation`, each of whose methods runs in a scope that holds `decision`: the `then` an await
 * calls and the method Prisma's own batch starts it with alike, so the queries the operation runs
 * reach the audit extension with the decision made for it, whoever starts it
 */
const withWritePolicyDecision = (decision: WritePolicyDecision | undefined, operation: unknown): unknown =>
  isObject(operation)
    ? new Proxy(operation, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function'
            ? (...args: unknown[]) =>
                withScope({ writePolicyDecision: decision }, () => Reflect.apply(value, target, args))
            : value;
        },
      })
    : operation;

const awaitsAudit = (decision: WritePolicyDecision | undefined): boolean =>
  decision?.policy.sampled === true && decision.policy.atomic;

const createRecipeFactory = (config: RecipeConfig) => {
  const run = async (recipe: Recipe): Promise<unknown> => {
    const decision = decisionOf(recipe, config);
    return awaitsAudit(decision)
      ? await runInTransaction(
          recipe.receiver,
          async (tx) => await withWritePolicyDecision(decision, replay(recipe, tx)),
        )
      : await withWritePolicyDecision(decision, replay(recipe, recipe.target));
  };

  const start = (recipe: Recipe): Promise<unknown> => {
    switch (recipe.state.kind) {
      case 'pending': {
        const result = run(recipe);
        recipe.state = { kind: 'started', result };
        return result;
      }
      case 'started':
        return recipe.state.result;
      case 'taken-by-batch':
        return Promise.reject(new Error('The operation was given to a batch $transaction, which runs it'));
      default: {
        const exhaustiveCheck: never = recipe.state;
        throw new Error(`[@prisma-audit] Unhandled recipe state: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };

  /** The `then`, `catch` or `finally` of the recipe, each of which starts it */
  const promiseMethodOf = (recipe: Recipe, prop: string | symbol): unknown => {
    switch (prop) {
      case 'then':
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          start(recipe).then(onFulfilled, onRejected);
      case 'catch':
        return (onRejected?: (reason: unknown) => unknown) => start(recipe).catch(onRejected);
      case 'finally':
        return (onFinally?: () => void) => start(recipe).finally(onFinally);
      default:
        return undefined;
    }
  };

  const relatedModelOf = (recipe: Recipe, prop: string | symbol): string | undefined =>
    typeof prop === 'string' && recipe.fluentModel !== undefined
      ? config.relatedModel(recipe.fluentModel, prop)
      : undefined;

  /** The fluent relation call `prop` names on the recipe's result, when one can follow */
  const relationCallOf = (recipe: Recipe, prop: string | symbol): unknown => {
    const relatedModel = relatedModelOf(recipe, prop);
    if (typeof prop !== 'string' || relatedModel === undefined) {
      return undefined;
    }
    return (...args: unknown[]) =>
      create({
        ...recipe,
        relationCalls: [...recipe.relationCalls, { method: prop, args }],
        fluentModel: relatedModel,
        state: { kind: 'pending' },
      });
  };

  const create = (recipe: Recipe): object => {
    const handle: object = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === Symbol.toStringTag ? RECIPE_TAG : (promiseMethodOf(recipe, prop) ?? relationCallOf(recipe, prop)),
        has: (_target, prop) =>
          prop === Symbol.toStringTag ||
          promiseMethodOf(recipe, prop) !== undefined ||
          relatedModelOf(recipe, prop) !== undefined,
      },
    );
    recipes.set(handle, recipe);
    return handle;
  };

  return { create };
};

/**
 * Wraps the model delegates and raw-query methods of the clients `config` is used for, caching
 * each wrapper per client so that a property read twice returns the same value.
 */
export const createRecipeClient = (config: RecipeConfig) => {
  const factory = createRecipeFactory(config);
  const wrappers = new WeakMap<object, Map<string, unknown>>();

  const cached = (receiver: object, key: string, build: () => unknown): unknown => {
    let byKey = wrappers.get(receiver);
    if (!byKey) {
      byKey = new Map();
      wrappers.set(receiver, byKey);
    }
    if (!byKey.has(key)) {
      byKey.set(key, build());
    }
    return byKey.get(key);
  };

  const delegateOf = (receiver: object, target: object, accessor: string, model: string): unknown => {
    const delegate: unknown = Reflect.get(target, accessor);
    if (!isObject(delegate)) {
      return delegate;
    }
    const actions = new Map<string, unknown>();
    return new Proxy(delegate, {
      get(delegateTarget, prop) {
        if (typeof prop !== 'string' || !MODEL_ACTIONS.has(prop)) {
          return Reflect.get(delegateTarget, prop);
        }
        if (!actions.has(prop)) {
          actions.set(prop, (...args: unknown[]) =>
            factory.create({
              receiver,
              target,
              accessor,
              model,
              call: { method: prop, args },
              relationCalls: [],
              fluentModel: FLUENT_ACTIONS.has(prop) ? model : undefined,
              state: { kind: 'pending' },
            }),
          );
        }
        return actions.get(prop);
      },
    });
  };

  /** The value `receiver` returns for `prop`, or undefined when the property is not wrapped */
  const propertyOf = (
    receiver: object,
    target: object,
    prop: string | symbol,
  ): { readonly value: unknown } | undefined => {
    if (typeof prop !== 'string') {
      return undefined;
    }
    const model = config.modelOfAccessor.get(prop);
    if (model !== undefined) {
      return { value: cached(receiver, prop, () => delegateOf(receiver, target, prop, model)) };
    }
    if (RAW_METHODS.has(prop) && typeof Reflect.get(target, prop) === 'function') {
      return {
        value: cached(
          receiver,
          prop,
          () =>
            (...args: unknown[]) =>
              factory.create({
                receiver,
                target,
                accessor: undefined,
                model: undefined,
                call: { method: prop, args },
                relationCalls: [],
                fluentModel: undefined,
                state: { kind: 'pending' },
              }),
        ),
      };
    }
    return undefined;
  };

  return { propertyOf };
};

export interface BatchRecipes {
  /** Whether some operation of the batch is an audited write whose audit is awaited */
  readonly awaitsAudit: boolean;
  /** The batch's operations made on `client`, not yet started, each to start with the write policy decided for it */
  readonly operationsOn: (client: object) => unknown[];
}

/**
 * The operations of a batch `$transaction([...])` called on `receiver`: every item must be a
 * recipe of `receiver` that has not run, or the batch is rejected before anything runs. The
 * recipes are taken by the batch, so awaiting one of them afterwards fails.
 */
export const takeBatchRecipes = (items: readonly unknown[], receiver: object, config: RecipeConfig): BatchRecipes => {
  const taken = items.map((item, index) => {
    const recipe = isObject(item) ? recipes.get(item) : undefined;
    const problem =
      recipe === undefined
        ? 'was not created by an audited client'
        : recipe.receiver !== receiver
          ? 'was created by another client than the one $transaction is called on'
          : recipe.state.kind !== 'pending'
            ? 'has already run'
            : undefined;
    if (recipe === undefined || problem !== undefined) {
      throw new Error(
        `The operation at index ${index} of the batch $transaction ${problem}: with write.implicitTransaction, every operation of a batch is created by the client $transaction is called on and passed to it before it is awaited`,
      );
    }
    return recipe;
  });
  for (const recipe of taken) {
    recipe.state = { kind: 'taken-by-batch' };
  }
  const decisions = taken.map((recipe) => decisionOf(recipe, config));
  return {
    awaitsAudit: decisions.some(awaitsAudit),
    operationsOn: (client) =>
      taken.map((recipe, index) => withWritePolicyDecision(decisions[index], replay(recipe, client))),
  };
};
