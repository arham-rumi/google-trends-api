export { GoogleTrendsClient, createClient } from './client.js';

export { getResultMetadata } from './result-metadata.js';
export type { ResultMetadata, ResultSource } from './result-metadata.js';

export {
  GoogleTrendsError,
  HttpStatusError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  RequestAbortedError,
  RequestTimeoutError,
  WidgetNotFoundError,
} from './errors.js';

export type { GoogleTrendsErrorCode } from './errors.js';

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
  CacheOptions,
  FetchLike,
  GoogleTrendsClientOptions,
  HttpHeadersInit,
  QueryParameters,
  QueryPrimitive,
  QueryValue,
  RateLimitOptions,
  ResolvedCacheOptions,
  ResolvedGoogleTrendsClientOptions,
  ResolvedRateLimitOptions,
  RetryOptions,
} from './types.js';
