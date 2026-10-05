/**
 * Operation recipes
 *
 * With `openImplicitTransaction`, a call on a model delegate or a raw-query method of the audited
 * client, or of a client derived from it, does not reach Prisma when it is made. It returns a
 * recipe: a lazy thenable holding the client the call was made on, the call, and the fluent
 * relation calls chained on it. Awaiting the recipe replays the calls on that client, inside an
 * interactive transaction of the client when the call is a write whose audit is awaited and no
 * transaction is active, so the call enters the client's extension chain once, already inside the
 * transaction. A batch `$transaction([...])` replays the client's recipes in one transaction. A
 * recipe is not a PrismaPromise: Prisma's own `$transaction` rejects it.
 */

import { isProcessingAuditLog } from './scope.js';

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
  /** Whether a call of `action` on `model` is audited with an audit that is awaited */
  readonly awaitsAudit: (model: string, action: string) => boolean;
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
  /** The run the recipe started when it was first awaited or taken by a batch */
  started?: Promise<unknown> | 'taken-by-batch';
}

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

/**
 * Whether the recipe, run now, is an audited write whose audit is awaited. A call of the audited
 * client inside a callback of your interactive `$transaction` is one too: the call is not made on
 * the transaction's client, so it runs in a transaction of its own, together with its audit.
 */
const awaitsAuditNow = (recipe: Recipe, config: RecipeConfig): boolean =>
  recipe.model !== undefined && !isProcessingAuditLog() && config.awaitsAudit(recipe.model, recipe.call.method);

const createRecipeFactory = (config: RecipeConfig) => {
  const start = (recipe: Recipe): Promise<unknown> => {
    if (recipe.started === undefined) {
      recipe.started = awaitsAuditNow(recipe, config)
        ? runInTransaction(recipe.receiver, async (tx) => await replay(recipe, tx))
        : Promise.resolve(replay(recipe, recipe.target));
    }
    if (recipe.started === 'taken-by-batch') {
      return Promise.reject(new Error('The operation was given to a batch $transaction, which runs it'));
    }
    return recipe.started;
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

  /** The fluent relation call `prop` names on the recipe's result, when one can follow */
  const relationCallOf = (recipe: Recipe, prop: string | symbol): unknown => {
    const relatedModel =
      typeof prop === 'string' && recipe.fluentModel !== undefined
        ? config.relatedModel(recipe.fluentModel, prop)
        : undefined;
    if (typeof prop !== 'string' || relatedModel === undefined) {
      return undefined;
    }
    return (...args: unknown[]) =>
      create({
        ...recipe,
        relationCalls: [...recipe.relationCalls, { method: prop, args }],
        fluentModel: relatedModel,
        started: undefined,
      });
  };

  const create = (recipe: Recipe): object => {
    const handle: object = new Proxy(
      {},
      { get: (_target, prop) => promiseMethodOf(recipe, prop) ?? relationCallOf(recipe, prop) },
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
  /** The batch's operations made on `client`, not yet started */
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
          : recipe.started !== undefined
            ? 'has already run'
            : undefined;
    if (recipe === undefined || problem !== undefined) {
      throw new Error(
        `The operation at index ${index} of the batch $transaction ${problem}: with openImplicitTransaction, every operation of a batch is created by the client $transaction is called on and passed to it before it is awaited`,
      );
    }
    return recipe;
  });
  for (const recipe of taken) {
    recipe.started = 'taken-by-batch';
  }
  return {
    awaitsAudit: taken.some((recipe) => awaitsAuditNow(recipe, config)),
    operationsOn: (client) => taken.map((recipe) => replay(recipe, client)),
  };
};
