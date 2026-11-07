/**
 * Operation recipes
 *
 * A call on a model delegate or a raw-query method of the audited client, of a client derived from
 * it, or of the client an interactive `$transaction` callback receives, does not reach Prisma when
 * it is made. It returns a recipe: a lazy thenable holding the client the call was made on, the
 * transaction of that client if it is one, the call, and the fluent relation calls chained on it.
 * Awaiting the recipe replays the calls on that client and starts Prisma's operation inside a scope
 * that binds it to that transaction, or to none, so the audit takes the operation's transaction
 * from the client it was issued on, not from whatever transaction is open around the call. A recipe
 * of a client outside any transaction runs an atomic write in an interactive transaction of that
 * client, so the call enters the client's extension chain once, already inside the transaction. A
 * batch `$transaction([...])` takes the client's recipes and runs them. A recipe is not a
 * PrismaPromise: Prisma's own `$transaction` rejects it. The `$parent` of such a client, and of
 * its model delegates, is Prisma's, wrapped as the client is, so a call on it is bound the same
 * way. Each wrapper stands for a client outside any transaction, its outer client; a model write
 * of a wrapper whose outer client carries no audit hook is rejected (`AuditParentWriteError`).
 */

import { AuditParentWriteError } from '../errors.js';
import { isAuditableAction } from '../utils/extension-utils.js';
import { invokeMethod } from '../utils/invoke-method.js';
import type { OpenTransaction } from './interactive-transaction.js';
import { type ActiveTransaction, type RuntimeScope, withinAudit, withScope } from './scope.js';

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
  /**
   * The model each model delegate property of the client names: its camelCase accessor and its
   * schema name, both of which Prisma exposes
   */
  readonly modelOfDelegateProperty: ReadonlyMap<string, string>;
  /** The model a relation field of `model` leads to */
  readonly relatedModel: (model: string, field: string) => string | undefined;
  /**
   * Whether a call of `action` on `model` with `args`, the arguments the call was made with, is an
   * audited atomic write, which a client outside any transaction runs in one of its own. The hook
   * decides the write mode again from the arguments that reach it.
   */
  readonly isAtomicWrite: (model: string, action: string, args: unknown) => boolean;
}

interface RecipeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A wrapped client the calls of a recipe are made on */
export interface IssuingClient {
  /** The audited client the call was made on, the one a batch `$transaction([...])` takes it for */
  readonly receiver: object;
  /** The client behind `receiver`, the one Prisma runs the call on, and opens a transaction on */
  readonly target: object;
  /** The interactive transaction `target` is the client of; undefined for a client outside any */
  readonly transaction: ActiveTransaction | undefined;
  /**
   * The client outside any transaction this wrapper stands for: `target` itself, or the client
   * whose transaction client `target` is
   */
  readonly outerClient: object;
  /**
   * Whether `outerClient` carries no audit hook, so that a model write of the client is rejected
   * when it starts
   */
  readonly belowAudit: boolean;
}

interface Recipe extends IssuingClient {
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

/** Makes the recipe's calls on `client`, and returns Prisma's operation, not yet started */
const replay = (recipe: Recipe, client: object): unknown => {
  const owner = recipe.accessor === undefined ? client : Reflect.get(client, recipe.accessor);
  let operation = invokeMethod(owner, recipe.call.method, recipe.call.args);
  for (const relationCall of recipe.relationCalls) {
    operation = invokeMethod(operation, relationCall.method, relationCall.args);
  }
  return operation;
};

const isAtomicWriteRecipe = (recipe: Recipe, config: RecipeConfig): boolean =>
  recipe.model !== undefined &&
  !withinAudit() &&
  config.isAtomicWrite(recipe.model, recipe.call.method, recipe.call.args[0]);

/**
 * `operation`, each of whose methods runs in a scope that merges `scope` over the current one: the
 * `then` an await calls and the method Prisma's own batch starts it with alike, so the queries the
 * operation runs reach the audit extension with that scope, whoever starts it
 */
const startingIn = (scope: RuntimeScope, operation: unknown): unknown =>
  isObject(operation)
    ? new Proxy(operation, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function'
            ? (...args: unknown[]) => withScope(scope, () => Reflect.apply(value, target, args))
            : value;
        },
      })
    : operation;

/**
 * Replays the recipe on `client` and starts the operation, both bound to `transaction`: a method an
 * extension overrides a built-in action with runs during the replay, and the operation it returns
 * starts in the flow it was created in
 */
const startOn = async (
  recipe: Recipe,
  client: object,
  transaction: ActiveTransaction | undefined,
): Promise<unknown> => {
  const scope: RuntimeScope = { binding: { transaction } };
  return await withScope(scope, () => startingIn(scope, replay(recipe, client)));
};

const isModelWrite = (recipe: Recipe): recipe is Recipe & { readonly model: string } =>
  recipe.model !== undefined && isAuditableAction(recipe.call.method);

const rejectionOf = (recipe: Recipe): AuditParentWriteError | undefined =>
  recipe.belowAudit && isModelWrite(recipe)
    ? new AuditParentWriteError({ modelName: recipe.model, operation: recipe.call.method })
    : undefined;

/**
 * Runs `body` in an interactive transaction of `issuer`'s client, nested in `issuer`'s transaction
 * when it has one, whose `boundClient` is bound to it with `issuer`'s outer client
 */
type OpenTransactionOn = (
  issuer: IssuingClient,
  options: readonly unknown[],
  body: (transaction: ActiveTransaction) => Promise<unknown>,
) => Promise<unknown>;

const createRecipeFactory = (config: RecipeConfig, openTransactionOn: OpenTransactionOn) => {
  const run = async (recipe: Recipe): Promise<unknown> => {
    const rejection = rejectionOf(recipe);
    if (rejection !== undefined) {
      throw rejection;
    }
    return recipe.transaction === undefined && isAtomicWriteRecipe(recipe, config)
      ? await openTransactionOn(recipe, [], (transaction) => startOn(recipe, transaction.client, transaction))
      : await startOn(recipe, recipe.target, recipe.transaction);
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
 * Wraps the model delegates, raw-query methods, `$parent` and `$transaction` of the clients
 * `config` is used for, caching each wrapper per client so that a property read twice returns the
 * same value. `openTransaction` opens every interactive transaction such a client runs in;
 * `clientOf` returns the one wrapper of a client outside any transaction, wrapped as the audited
 * client is; `carriesAudit` tells whether a client outside any transaction is one the audit hook
 * applies to: the client it was applied to, extended with it, or a client derived from that one;
 * `transactionMethodOf` makes the `$transaction` of a client from the client's own.
 */
export const createRecipeClient = (
  config: RecipeConfig,
  openTransaction: OpenTransaction,
  clientOf: (client: object) => object,
  carriesAudit: (client: object) => boolean,
  transactionMethodOf: (issuer: IssuingClient, original: (...args: unknown[]) => unknown) => unknown,
) => {
  const openTransactionOn: OpenTransactionOn = (issuer, options, body) =>
    openTransaction(
      issuer.target,
      options,
      (transaction) => boundTo(transaction, transaction.client, issuer.outerClient),
      body,
      issuer.transaction,
    );
  const factory = createRecipeFactory(config, openTransactionOn);
  const propertyCache = new WeakMap<object, Map<string, unknown>>();

  const cached = (receiver: object, key: string, build: () => unknown): unknown => {
    let byKey = propertyCache.get(receiver);
    if (!byKey) {
      byKey = new Map();
      propertyCache.set(receiver, byKey);
    }
    if (!byKey.has(key)) {
      byKey.set(key, build());
    }
    return byKey.get(key);
  };

  /**
   * The `$parent` of `issuer`, or of one of its model delegates, from Prisma's own, `parent`: outside
   * any transaction the one wrapper of `parent`, whichever client or delegate it was read from;
   * inside one, where Prisma returns a new transaction client on every read, `parent` bound to the
   * transaction with the client below `issuer`'s outer client as its outer client, or `parent`
   * itself, which carries no audit hook, when Prisma names none below.
   */
  const parentOf = (issuer: IssuingClient, parent: unknown): unknown => {
    if (!isObject(parent)) {
      return parent;
    }
    if (issuer.transaction === undefined) {
      return clientOf(parent);
    }
    const outerParent: unknown = Reflect.get(issuer.outerClient, '$parent');
    return boundTo(issuer.transaction, parent, isObject(outerParent) ? outerParent : parent);
  };

  const delegateOf = (issuer: IssuingClient, accessor: string, model: string): unknown => {
    const delegate: unknown = Reflect.get(issuer.target, accessor);
    if (!isObject(delegate)) {
      return delegate;
    }
    const actions = new Map<string, unknown>();
    let parent: { readonly value: unknown } | undefined;
    return new Proxy(delegate, {
      get(delegateTarget, prop) {
        if (prop === '$parent') {
          parent ??= { value: parentOf(issuer, Reflect.get(delegateTarget, prop)) };
          return parent.value;
        }
        if (typeof prop !== 'string' || !MODEL_ACTIONS.has(prop)) {
          return Reflect.get(delegateTarget, prop);
        }
        if (!actions.has(prop)) {
          actions.set(prop, (...args: unknown[]) =>
            factory.create({
              ...issuer,
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

  /** The value `issuer.receiver` returns for `prop`, or undefined when the property is not wrapped */
  const wrappedPropertyOf = (issuer: IssuingClient, prop: string | symbol): { readonly value: unknown } | undefined => {
    if (typeof prop !== 'string') {
      return undefined;
    }
    if (prop === '$parent') {
      return { value: cached(issuer.receiver, prop, () => parentOf(issuer, Reflect.get(issuer.target, prop))) };
    }
    if (prop === '$transaction') {
      const original: unknown = Reflect.get(issuer.target, prop);
      return typeof original === 'function'
        ? {
            value: cached(issuer.receiver, prop, () =>
              transactionMethodOf(issuer, (...args) => Reflect.apply(original, issuer.target, args)),
            ),
          }
        : undefined;
    }
    const model = config.modelOfDelegateProperty.get(prop);
    if (model !== undefined) {
      return { value: cached(issuer.receiver, prop, () => delegateOf(issuer, prop, model)) };
    }
    if (RAW_METHODS.has(prop) && typeof Reflect.get(issuer.target, prop) === 'function') {
      return {
        value: cached(
          issuer.receiver,
          prop,
          () =>
            (...args: unknown[]) =>
              factory.create({
                ...issuer,
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

  /** The value the audited client `receiver`, outside any transaction, returns for `prop`, when it is wrapped */
  const propertyOf = (receiver: object, target: object, prop: string | symbol) =>
    wrappedPropertyOf(
      { receiver, target, transaction: undefined, outerClient: target, belowAudit: !carriesAudit(target) },
      prop,
    );

  /**
   * `client`, a client of `transaction` that stands for `outerClient`, whose operations are recipes
   * bound to `transaction`. Every other property is the transaction client's own.
   */
  const boundTo = <T extends object>(transaction: ActiveTransaction, client: T, outerClient: object): T => {
    const belowAudit = !carriesAudit(outerClient);
    return new Proxy(client, {
      get(target, prop, receiver: object) {
        const wrapped = wrappedPropertyOf({ receiver, target, transaction, outerClient, belowAudit }, prop);
        return wrapped ? wrapped.value : Reflect.get(target, prop);
      },
    });
  };

  return { propertyOf, openTransactionOn };
};

export interface BatchRecipes {
  /** Whether some operation of the batch is a model write, of an audited model or not */
  readonly holdsModelWrite: boolean;
  /**
   * The batch's operations made on `client`, not yet started, for Prisma's own batch: each starts
   * without a binding, so an audited write that reached the audit from one would be rejected
   */
  readonly operationsOn: (client: object) => unknown[];
  /**
   * Runs the batch's operations on the client of `transaction`, one after another in list order, as
   * Prisma runs a batch, each bound to `transaction`
   */
  readonly runIn: (transaction: ActiveTransaction) => Promise<unknown[]>;
}

/**
 * The operations of a batch `$transaction([...])` called on `receiver`: every item must be a
 * recipe of `receiver` that has not run, and none may be a model write of a client below the
 * audit, decided as when a recipe starts, or the batch is rejected before anything runs. The
 * recipes are taken by the batch, so awaiting one of them afterwards fails.
 */
export const takeBatchRecipes = (items: readonly unknown[], receiver: object): BatchRecipes => {
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
        `The operation at index ${index} of the batch $transaction ${problem}: every operation of a batch is created by the client $transaction is called on and passed to it before it is awaited`,
      );
    }
    return recipe;
  });
  for (const recipe of taken) {
    const rejection = rejectionOf(recipe);
    if (rejection !== undefined) {
      throw rejection;
    }
  }
  for (const recipe of taken) {
    recipe.state = { kind: 'taken-by-batch' };
  }
  return {
    holdsModelWrite: taken.some(isModelWrite),
    operationsOn: (client) => taken.map((recipe) => startingIn({ binding: undefined }, replay(recipe, client))),
    runIn: async (transaction) => {
      const results: unknown[] = [];
      for (const recipe of taken) {
        results.push(await startOn(recipe, transaction.client, transaction));
      }
      return results;
    },
  };
};
