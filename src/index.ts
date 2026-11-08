export { GoogleTrendsClient, createClient } from './client.js';

export type {
  BatchDeduplicationKey,
  BatchFulfilledResult,
  BatchOptions,
  BatchProgress,
  BatchRejectedResult,
  BatchResult,
  BatchWorker,
  BatchWorkerContext,
} from './batch.js';

export { getResultMetadata } from './result-metadata.js';
export type { ResultMetadata, ResultSource } from './result-metadata.js';

export { RedisCacheStore, createRedisCacheStore } from './cache/redis-store.js';
export type {
  RedisCacheStoreOptions,
  RedisCommandExecutor,
  RedisDeleteCommand,
} from './cache/redis-store.js';

export {
  GoogleTrendsError,
  HttpStatusError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  RequestBudgetExceededError,
  RequestAbortedError,
  RequestTimeoutError,
  WidgetNotFoundError,
} from './errors.js';

export type { GoogleTrendsErrorCode, RequestBudgetReason } from './errors.js';

export { INTEREST_BY_REGION_RESOLUTIONS } from './google/interest-by-region.js';

export type {
  InterestByRegionCoordinates,
  InterestByRegionOptions,
  InterestByRegionPoint,
  InterestByRegionResolution,
  InterestByRegionResult,
  InterestByRegionValue,
} from './google/interest-by-region.js';

export type {
  InterestOverTimeAverage,
  InterestOverTimeOptions,
  InterestOverTimePoint,
  InterestOverTimeResult,
  InterestOverTimeValue,
} from './google/interest-over-time.js';

export { GOOGLE_TRENDS_PROPERTIES } from './google/constants.js';
export type { GoogleTrendsProperty } from './google/constants.js';

export type {
  GoogleTrendsComparisonInput,
  GoogleTrendsComparisonItem,
  GoogleTrendsItemComparisonInput,
  GoogleTrendsKeywordComparisonInput,
} from './google/explore.js';

export type {
  AutocompleteOptions,
  AutocompleteResult,
  AutocompleteSuggestion,
} from './google/autocomplete.js';

export type {
  TrendingNowItem,
  TrendingNowNewsItem,
  TrendingNowOptions,
  TrendingNowResult,
} from './google/trending-now.js';

export type {
  RelatedQueriesResult,
  RelatedQueryItem,
  RelatedSearchesOptions,
  RelatedTopic,
  RelatedTopicItem,
  RelatedTopicsResult,
} from './google/related-searches.js';

export type {
  AdaptivePacingOptions,
  CacheCoordinationOptions,
  CacheOptions,
  CacheStore,
  CacheStoreResult,
  CoordinatedCacheStore,
  FetchLike,
  GoogleTrendsClientOptions,
  GoogleTrendsEvent,
  GoogleTrendsEventListener,
  GoogleTrendsMetrics,
  HttpHeadersInit,
  QueryParameters,
  QueryPrimitive,
  QueryValue,
  RateLimitOptions,
  RequestBudgetOptions,
  ResolvedAdaptivePacingOptions,
  ResolvedCacheCoordinationOptions,
  ResolvedCacheOptions,
  ResolvedGoogleTrendsClientOptions,
  ResolvedRateLimitOptions,
  ResolvedRequestBudgetOptions,
  RetryOptions,
  ObservabilityOptions,
} from './types.js';
