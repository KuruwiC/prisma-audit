/**
 * Pre-fetch Module
 *
 * @module lifecycle/pre-fetch
 */

export {
  categorizeRelationType,
  type DetectNestedOperationsFn,
  findDMMFField,
  type GetOperationConfig,
  type NestedOperation as CoordinatorNestedOperation,
  PRE_FETCH_INTERNAL_RESULTS,
  type PreFetchCoordinatorDependencies,
  type PreFetchResultsWithInternal,
  preFetchNestedRecordsBeforeOperation,
  resolveParentModelFromPath,
} from './coordinator.js';

export {
  extractEntityId,
  extractWhereClause,
  type ModelClientWithFindFirst,
  type NestedOperation,
  preFetchOneToManyRelation,
} from './one-to-many-fetcher.js';

export {
  type DMMFField,
  type DMMFModel,
  type DMMFRelationField,
  determineRelationFields,
  fetchParentRecordIfNeeded,
  type ModelClientWithFindUnique,
  type PreFetchOneToOneResult,
  type PrismaDMMF,
  preFetchOneToOneRelation,
  resolveEffectiveParentWhere,
} from './one-to-one-fetcher.js';

export {
  extractEntityIdOrDefault,
  getPreFetchResult,
  type NestedPreFetchResults,
  PRE_FETCH_DEFAULT_KEY,
  type PreFetchResult,
  storePreFetchResult,
} from './pre-fetch-result-store.js';
