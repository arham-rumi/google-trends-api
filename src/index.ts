export { GoogleTrendsClient, createClient } from './client.js';

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

export type { GoogleTrendsProperty } from './google/constants.js';

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
  FetchLike,
  GoogleTrendsClientOptions,
  HttpHeadersInit,
  QueryParameters,
  QueryPrimitive,
  QueryValue,
  ResolvedGoogleTrendsClientOptions,
  RetryOptions,
} from './types.js';
